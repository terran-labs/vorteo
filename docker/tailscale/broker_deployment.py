"""Eight-file commit primitive for tracked broker deployment.

This module has no command-line entrypoint or service controls. The coordinator's
native adapter must establish and continually verify its cooperative process
window before calling it. Holding broker locks alone does not establish that window.
"""
from contextlib import ExitStack
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid

from channel_identity import broker_lock, physical_directory, read_file, file_identity
from broker_rebind import snapshot, preserved

FILES = {'https_broker.py', 'https-preview.py', 'host_config.py', 'channel_identity.py'}
MAX_CODE = 256 * 1024


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def directory_pin(info):
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)]


def exclusive(fd, name, raw, mode=0o600):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         mode, dir_fd=fd)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(fd)


def exchange(fd, staged, destination):
    """Retain even an unexpectedly replaced destination rather than destroying it."""
    if sys.platform != 'darwin':
        raise ValueError('Broker deployment requires Darwin atomic file exchange')
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    rename = libc.renameatx_np
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                       ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(fd, os.fsencode(staged), fd, os.fsencode(destination), 2):
        raise OSError(ctypes.get_errno(), 'Broker file exchange failed')
    os.fsync(fd)


def validate_plan(plan, allowed_roots):
    if set(plan) != {'version', 'operation', 'id', 'evidenceDirectory', 'targets'}:
        raise ValueError('Unexpected deployment plan fields')
    if plan['version'] != 1 or plan['operation'] != 'preview-broker-consumer-deployment':
        raise ValueError('Unsupported deployment operation')
    if str(uuid.UUID(plan['id'])) != plan['id']:
        raise ValueError('Noncanonical deployment identity')
    targets = plan['targets']
    if len(targets) != 2 or len(set(allowed_roots)) != 2:
        raise ValueError('Deployment requires the configured pair')
    if {item['root'] for item in targets} != set(allowed_roots):
        raise ValueError('Deployment roots differ from protected configuration')
    for target in targets:
        if set(target) != {'root', 'directory', 'files', 'preservationSha256'}:
            raise ValueError('Unexpected deployment target fields')
        if set(target['files']) != FILES:
            raise ValueError('Deployment requires exactly four consumer files')
        for name, item in target['files'].items():
            if set(item) != {'expected', 'candidate', 'mode'}:
                raise ValueError('Unexpected deployment file fields')
            if item['mode'] not in (0o600, 0o644, 0o700, 0o755):
                raise ValueError('Unsafe candidate file mode')
            expected = item['expected']
            if expected['kind'] == 'absent':
                if name != 'channel_identity.py' or set(expected) != {'kind'}:
                    raise ValueError('Only the verifier may be absent')
            elif expected['kind'] != 'present' or set(expected) != {'kind', 'sha256', 'identity'}:
                raise ValueError('Incomplete expected file identity')
            if set(item['candidate']) != {'path', 'sha256'}:
                raise ValueError('Incomplete candidate artifact')


def preservation(root):
    raw, info = read_file(root / 'host-config.json', protected=True)
    config = json.loads(raw)
    if config['deployment'] != str(root):
        raise ValueError('Broker config belongs to another deployment')
    marker, marker_info = read_file(Path(config['channel']) / 'installed.json', protected=True)
    return {
        'config': {'sha256': sha(raw), 'identity': file_identity(info)},
        'marker': {'sha256': sha(marker), 'identity': file_identity(marker_info)},
        'inventory': snapshot(config),
    }


def stable_preservation(state):
    """The part of a preservation report that a running broker leaves unchanged.

    A running broker rewrites its ledger on every cycle and producers keep adding
    inbox files, so a plan prepared while it runs can only bind the configuration
    and installed marker. The full inventory is still captured after suppression
    and compared across the commit window.
    """
    return {'config': state['config'], 'marker': state['marker']}


def approved_preservation_sha256(state, admission):
    """The preservation digest a plan approves for a channel admission mode."""
    if admission == 'refusing':
        return sha(encode(state))
    if admission == 'running':
        return sha(encode(stable_preservation(state)))
    raise ValueError('Unknown channel admission')


def assert_preserved(before, after):
    if before['config'] != after['config'] or before['marker'] != after['marker']:
        raise ValueError('Broker config or installed marker changed')
    return preserved(before['inventory'], after['inventory'])


def expected_file(root, name, expected):
    path = root / name
    if expected['kind'] == 'absent':
        try:
            path.lstat()
        except FileNotFoundError:
            return None
        raise ValueError('Expected absent verifier is present')
    raw, info = read_file(path, MAX_CODE, protected=True)
    if sha(raw) != expected['sha256'] or [str(value) for value in file_identity(info)] != expected['identity']:
        raise ValueError('Consumer preimage changed')
    return raw


def deploy_files(plan, allowed_roots, *, verify_window, checkpoint=lambda stage, index: None,
                 preservation_sha256=lambda root, state: sha(encode(state))):
    """Commit once inside a separately admitted, suppressed process window.

    verify_window must independently recheck the exact queue reservation, native
    suppression and participant commitments. Its returned binding must remain
    byte-identical throughout. It is a trusted port, never submitted plan data.
    preservation_sha256 maps a root's current preservation report to the digest the
    plan approved; like verify_window it is a trusted port. No failure handler
    resumes services, replays a write or deletes evidence.
    """
    validate_plan(plan, allowed_roots)
    binding = encode(verify_window())
    if binding in (b'null\n', b'false\n', b'true\n', b'{}\n'):
        raise ValueError('A complete independent window binding is required')
    with ExitStack() as stack:
        evidence = Path(plan['evidenceDirectory'])
        info, check_evidence = stack.enter_context(physical_directory(evidence))
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Unprotected deployment evidence directory')
        checks = []
        roots = {}
        for target in sorted(plan['targets'], key=lambda item: item['root']):
            root = Path(target['root'])
            info, check = stack.enter_context(physical_directory(root))
            if directory_pin(info) != target['directory'] or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Deployment directory identity or protection changed')
            checks.extend([check, stack.enter_context(broker_lock(root, create=False))])
            roots[str(root)] = (root, check.directory_fd)

        def guard():
            check_evidence()
            for check in checks:
                check()
            if encode(verify_window()) != binding:
                raise ValueError('Deployment process window changed')

        def record(name, value):
            guard()
            exclusive(check_evidence.directory_fd, name, encode(value))
            guard()

        before, candidates, originals = {}, {}, {}
        for target in plan['targets']:
            root, _ = roots[target['root']]
            state = preservation(root)
            if preservation_sha256(str(root), state) != target['preservationSha256']:
                raise ValueError('Preservation inventory changed; refresh preparation')
            before[str(root)] = state
            for name, item in target['files'].items():
                key = (str(root), name)
                originals[key] = expected_file(root, name, item['expected'])
                raw, _ = read_file(item['candidate']['path'], MAX_CODE, protected=True)
                if sha(raw) != item['candidate']['sha256']:
                    raise ValueError('Candidate artifact changed')
                candidates[key] = raw
        record('intent.json', {'planSha256': sha(encode(plan)), 'plan': plan,
                               'windowSha256': sha(binding), 'before': before})
        acknowledgements = []
        for target in plan['targets']:
            root, fd = roots[target['root']]
            for name, item in sorted(target['files'].items()):
                index = len(acknowledgements)
                key = (str(root), name)
                original = originals[key]
                if original is not None:
                    guard()
                    exclusive(check_evidence.directory_fd, f'original-{index}', original)
                record(f'intent-{index}.json', {'root': str(root), 'name': name,
                                               'expected': item['expected'], 'candidate': item['candidate']})
                checkpoint('before-write', index)
                guard()
                expected_file(root, name, item['expected'])
                if original is None:
                    exclusive(fd, name, candidates[key], item['mode'])
                else:
                    staged = f'.broker-deployment-{plan["id"]}-{index}'
                    exclusive(fd, staged, candidates[key], item['mode'])
                    guard()
                    expected_file(root, name, item['expected'])
                    exchange(fd, staged, name)
                    displaced, displaced_info = read_file(root / staged, MAX_CODE, protected=True)
                    # Rename may update ctime; the displaced inode and all other
                    # preimage attributes must still match the reviewed original.
                    if displaced != original or [str(value) for value in file_identity(displaced_info)][:-1] != item['expected']['identity'][:-1]:
                        raise ValueError('Unexpected displaced file retained; inspect uncertainty')
                checkpoint('after-write', index)
                guard()
                installed, installed_info = read_file(root / name, MAX_CODE, protected=True)
                if installed != candidates[key] or stat.S_IMODE(installed_info.st_mode) != item['mode']:
                    raise ValueError('Installed consumer readback differs')
                ack = {'root': str(root), 'name': name, 'sha256': sha(installed),
                       'identity': file_identity(installed_info)}
                record(f'ack-{index}.json', ack)
                acknowledgements.append(ack)
        additions = {}
        for root, _ in roots.values():
            additions[str(root)] = assert_preserved(before[str(root)], preservation(root))
        for ack in acknowledgements:
            raw, info = read_file(Path(ack['root']) / ack['name'], MAX_CODE, protected=True)
            if sha(raw) != ack['sha256'] or file_identity(info) != ack['identity']:
                raise ValueError('Installed consumer changed before commitment')
        record('commit.json', {'planSha256': sha(encode(plan)), 'files': acknowledgements,
                               'inboxAdditions': additions, 'windowSha256': sha(binding)})
        return {'kind': 'files-committed', 'planSha256': sha(encode(plan)),
                'registrationsRestored': False, 'serviceStarted': False}
