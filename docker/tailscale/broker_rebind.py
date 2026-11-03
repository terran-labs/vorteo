"""Config-only worker for the tracked coordinator. No standalone command or admission.

The caller supplies an approved exact plan, protected allowlist and exclusive job
folder. Two replacements are sequential; failure retains evidence and never retries.
"""
from contextlib import ExitStack
import hashlib
from itertools import islice
import json
import os
from pathlib import Path
import stat
import uuid
from channel_identity import (NAMES, FENCE, apfs_volume, broker_lock, file_identity,
                              physical_directory, read_file, verify_channel)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def exclusive(path, data, mode=0o600, directory_fd=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory_fd)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def snapshot(config):
    """Only published inbox files are tracked. Producer dotfiles are never touched."""
    root = Path(config['channel'])
    result = {}
    total = 0
    for name in NAMES[1:]:
        directory = root / name
        with physical_directory(directory):
            # Bound enumeration itself, not just the resulting allocation.
            paths = list(islice(directory.iterdir(), 4097))
            if len(paths) > 4096:
                raise ValueError('Channel inventory exceeds bound')
            for path in sorted(paths):
                if name == 'inbox' and path.name.startswith('.'):
                    continue
                raw, info = read_file(path, 65536)
                total += len(raw)
                if total > 32 * 1024 * 1024:
                    raise ValueError('Channel bytes exceed bound')
                result[name + '/' + path.name] = {'sha256': sha(raw), 'identity': file_identity(info)}
    ledger = Path(config['deployment']) / 'https-broker-ledger.json'
    raw, info = read_file(ledger, protected=True)
    result['ledger'] = {'sha256': sha(raw), 'identity': file_identity(info)}
    value = json.loads(raw)
    if not isinstance(value.get('requests'), dict) or not isinstance(value.get('entries'), dict):
        raise ValueError('Invalid broker ledger')
    if any('receipts/' + request + '.json' not in result for request in value['requests']):
        raise ValueError('Indeterminate consumed request requires review')
    if any(entry.get('status') == 'pending' for entry in value['entries'].values()):
        raise ValueError('Pending broker start requires review')
    return result


def preserved(before, after):
    if any(after.get(name) != value for name, value in before.items()):
        raise ValueError('Existing channel or ledger changed')
    additions = sorted(set(after) - set(before))
    if any(not name.startswith('inbox/') for name in additions):
        raise ValueError('Unexpected non-request addition')
    return additions


def candidate(raw, item):
    config = json.loads(raw)
    if 'channelFilesystemIdentity' in config:
        raise ValueError('Channel already migrated; do not replay')
    updated = {**config, 'channelFilesystemIdentity': item['anchor']}
    data = encode(updated)
    if sha(data) != item['candidateSha256']:
        raise ValueError('Candidate digest differs from exact plan')
    return updated, data


def migrate(plan, allowed_configs, job_directory, cancelled=lambda: False,
            volume_reader=apfs_volume, checkpoint=lambda stage, index: None,
            expected_job_identity=None):
    """Called once after tracked dispatch. Cancellation is checked before each rename.

    The coordinator must mark a dispatched job uncertain after process loss. The
    exclusive intent also rejects replay, including after a partial replacement.
    """
    if plan.get('version') != 1 or plan.get('operation') != 'preview-broker-channel-rebind':
        raise ValueError('Unsupported broker plan')
    if str(uuid.UUID(plan['id'])) != plan['id']:
        raise ValueError('Noncanonical request identity')
    items = plan['brokers']
    paths = [item['configPath'] for item in items]
    if len(items) != 2 or len(set(paths)) != 2 or set(paths) != set(allowed_configs):
        raise ValueError('Broker target allowlist mismatch')
    job = Path(job_directory)
    if plan.get('evidenceDirectory') != str(job):
        raise ValueError('Evidence directory differs from reviewed plan')
    if any(item.get('fencePath') != str(Path(item['configPath']).parent / FENCE) for item in items):
        raise ValueError('Fence path differs from reviewed plan')
    with ExitStack() as stack:
        job_info, recheck_job = stack.enter_context(physical_directory(job))
        if expected_job_identity is not None and (job_info.st_dev, job_info.st_ino) != expected_job_identity:
            raise ValueError('Created job directory was replaced')
        if job_info.st_uid != os.getuid() or stat.S_IMODE(job_info.st_mode) != 0o700:
            raise ValueError('Unprotected job directory')
        # Lexical lock ordering is shared by every two-broker operation.
        locks = {path: stack.enter_context(broker_lock(Path(path).parent, create=False)) for path in sorted(paths)}
        checks = list(locks.values())
        def evidence(name, data):
            recheck_job()
            exclusive(name, data, directory_fd=recheck_job.directory_fd)
            os.fsync(recheck_job.directory_fd)
            recheck_job()
        originals, candidates, inventories = [], [], []
        for item in items:
            raw, info = read_file(item['configPath'], protected=True)
            if sha(raw) != item['expectedSha256']:
                raise ValueError('Config compare-and-swap mismatch')
            if info.st_gid != os.getgid():
                raise ValueError('Config group differs from executor')
            config, data = candidate(raw, item)
            if config['deployment'] != str(Path(item['configPath']).parent):
                raise ValueError('Config deployment differs from locked root')
            verify_channel(config, volume_reader)
            originals.append((raw, info))
            candidates.append((config, data))
            inventories.append(snapshot(config))
        if cancelled():
            raise ValueError('Cancelled before config preparation')
        recheck_job()
        evidence('intent.json', encode({'plan': plan, 'planSha256': sha(encode(plan))}))
        evidence('inventory-before.json', encode(inventories))
        commit = encode({'version': 1, 'planSha256': sha(encode(plan)), 'configs': {item['configPath']: item['candidateSha256'] for item in items}})
        fences = []
        for item in items:
            fence = {'version': 1, 'commitPath': str(job / 'commit.json'), 'commitSha256': sha(commit), 'configPath': item['configPath'], 'configSha256': item['candidateSha256']}
            lock = locks[item['configPath']]
            lock()
            exclusive(FENCE, encode(fence), directory_fd=lock.directory_fd)
            os.fsync(lock.directory_fd)
            lock()
            fence_raw, fence_info = read_file(item['fencePath'], protected=True)
            if fence_raw != encode(fence):
                raise ValueError('Created fence readback differs')
            fences.append((fence_raw, file_identity(fence_info)))
        stages = []
        for index, (item, (raw, info), (_, data)) in enumerate(zip(items, originals, candidates)):
            evidence('original-' + str(index) + '.json', raw)
            # Temporary files live beside their destination, never across volumes.
            stage = Path(item['configPath']).with_name('.broker-rebind-' + plan['id'] + '-' + str(index))
            exclusive(stage.name, data, stat.S_IMODE(info.st_mode), locks[item['configPath']].directory_fd)
            if read_file(stage, protected=True)[0] != data:
                raise ValueError('Staged candidate readback differs')
            sync_directory(stage.parent)
            stages.append((stage, file_identity(read_file(stage, protected=True)[1])))
        os.fsync(recheck_job.directory_fd)
        checkpoint('prepared', -1)
        for index, (item, (raw, info), (config, data), (stage, staged_identity)) in enumerate(zip(items, originals, candidates, stages)):
            if cancelled():
                raise ValueError('Cancelled at config boundary; inspect retained progress')
            for check in checks:
                check()
            recheck_job()
            for old, (current_config, _) in zip(inventories, candidates):
                preserved(old, snapshot(current_config))
                verify_channel(current_config, volume_reader)
            actual, current = read_file(item['configPath'], protected=True)
            if actual != raw or file_identity(current) != file_identity(info):
                raise ValueError('Config changed under consumer lock')
            if read_file(stage, protected=True)[0] != data:
                raise ValueError('Staged config changed')
            evidence('replace-intent-' + str(index) + '.json', encode({'before': sha(raw), 'after': sha(data)}))
            checkpoint('before-replace', index)
            locks[item['configPath']]()
            if file_identity(read_file(item['configPath'], protected=True)[1]) != file_identity(info):
                raise ValueError('Config changed before replacement')
            staged, staged_info = read_file(stage, protected=True)
            if staged != data or file_identity(staged_info) != staged_identity:
                raise ValueError('Staged config changed before replacement')
            # These are two distinct atomic replacements, NOT one transaction.
            directory_fd = locks[item['configPath']].directory_fd
            os.replace(stage.name, Path(item['configPath']).name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            checkpoint('after-replace', index)
            sync_directory(stage.parent)
            actual, current = read_file(item['configPath'], protected=True)
            if actual != data:
                raise ValueError('Replaced config readback differs')
            evidence('replaced-' + str(index) + '.json', encode({'sha256': sha(actual), 'identity': file_identity(current)}))
        additions, final_inventories = [], []
        for item, old, (config, data) in zip(items, inventories, candidates):
            if read_file(item['configPath'], protected=True)[0] != data:
                raise ValueError('Final config readback differs')
            verify_channel(config, volume_reader)
            final = snapshot(config)
            additions.append(preserved(old, final))
            final_inventories.append(final)
        for check in checks:
            check()
        recheck_job()
        result = {'status': 'succeeded', 'candidateHashes': [sha(data) for _, data in candidates],
                  'concurrentRequests': additions, 'consumerReload': 'next locked invocation',
                  'serviceStarted': False}
        evidence('inventory-after.json', encode(final_inventories))
        evidence('verified.json', encode(result))
        checkpoint('before-commit', -1)
        # The one shared commit record is the consumer activation point. Every
        # earlier failure leaves both consumers fenced, even after process loss.
        for item, (config, data) in zip(items, candidates):
            locks[item['configPath']]()
            if read_file(item['configPath'], protected=True)[0] != data:
                raise ValueError('Config changed before commit')
            verify_channel(config, volume_reader)
        for item, (raw, identity) in zip(items, fences):
            current, info = read_file(item['fencePath'], protected=True)
            if current != raw or file_identity(info) != identity:
                raise ValueError('Activation fence changed before commit')
        evidence('commit.json', commit)
        return result


def inspect_plan(plan, allowed_configs, volume_reader=apfs_volume):
    paths = [item['configPath'] for item in plan['brokers']]
    if len(paths) != 2 or len(set(paths)) != 2 or set(paths) != set(allowed_configs):
        raise ValueError('Broker target allowlist mismatch')
    with ExitStack() as stack:
        for path in sorted(paths):
            stack.enter_context(broker_lock(Path(path).parent, create=False))
        for item in plan['brokers']:
            raw, _ = read_file(item['configPath'], protected=True)
            if sha(raw) != item['expectedSha256']:
                raise ValueError('Config compare-and-swap mismatch')
            config, _ = candidate(raw, item)
            if config['deployment'] != str(Path(item['configPath']).parent):
                raise ValueError('Config deployment differs from locked root')
            verify_channel(config, volume_reader)
            snapshot(config)
    return {'ready': True, 'brokers': 2}


def coordinator_main():
    import signal
    import sys
    import uuid
    # The tracked parent also has a timeout. A timeout after dispatch is uncertain,
    # never authorization to invoke this worker again.
    signal.alarm(25)
    raw_request = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw_request) > 1024 * 1024:
        raise ValueError('Coordinator request exceeds bound')
    request = json.loads(raw_request)
    plan = request['plan']
    if str(uuid.UUID(plan['id'])) != plan['id']:
        raise ValueError('Noncanonical request identity')
    if request['operation'] == 'inspect':
        result = inspect_plan(plan, request['allowedConfigs'])
    elif request['operation'] == 'observe':
        approved = request['approvedPlanBytes'].encode('utf8')
        if len(approved) > 512 * 1024 or json.loads(approved) != plan or sha(approved) != request['approvedPlanSha256']:
            raise ValueError('Approved plan digest bridge differs')
        result = observe_outcome(plan, request['allowedConfigs'], request['evidenceRoot'])
        result.update({'id': plan['id'], 'planSha256': sha(approved), 'workerPlanSha256': sha(encode(plan))})
    elif request['operation'] == 'apply':
        root = Path(request['evidenceRoot'])
        with physical_directory(root) as (info, check):
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError('Unprotected evidence root')
            os.mkdir(plan['id'], mode=0o700, dir_fd=check.directory_fd)
            child = os.open(plan['id'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=check.directory_fd)
            try:
                created = os.fstat(child)
                os.fsync(check.directory_fd)
                check()
                result = migrate(plan, request['allowedConfigs'], root / plan['id'],
                                 expected_job_identity=(created.st_dev, created.st_ino))
            finally:
                os.close(child)
    else:
        raise ValueError('Unsupported coordinator operation')
    sys.stdout.write(json.dumps(result))


def observe_outcome(plan, allowed_configs, evidence_root, volume_reader=apfs_volume):
    """Observe a previous effect only. Never create evidence, replay or restore."""
    unresolved = {'kind': 'unresolved', 'reason': 'evidence-unconfirmed'}
    try:
        items = plan['brokers']
        paths = [item['configPath'] for item in items]
        job = Path(evidence_root) / str(uuid.UUID(plan['id']))
        if len(paths) != 2 or len(set(paths)) != 2 or set(paths) != set(allowed_configs) or str(job) != plan['evidenceDirectory']:
            return unresolved
        with ExitStack() as stack:
            info, recheck = stack.enter_context(physical_directory(job))
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                return unresolved
            locks = [stack.enter_context(broker_lock(Path(p).parent, create=False)) for p in sorted(paths)]
            def document(name, bound=2 * 1024 * 1024):
                return read_file(job / name, bound, protected=True)[0]
            intent = encode({'plan': plan, 'planSha256': sha(encode(plan))})
            if document('intent.json') != intent:
                return unresolved
            commit = encode({'version': 1, 'planSha256': sha(encode(plan)), 'configs': {item['configPath']: item['candidateSha256'] for item in items}})
            try:
                (job / 'rollback.pending.json').lstat()
            except FileNotFoundError:
                pass
            else:
                return unresolved
            selections = []
            configs = []
            for item in items:
                if item['fencePath'] != str(Path(item['configPath']).parent / FENCE):
                    return unresolved
                expected = encode({'version': 1, 'commitPath': str(job / 'commit.json'), 'commitSha256': sha(commit), 'configPath': item['configPath'], 'configSha256': item['candidateSha256']})
                if read_file(item['fencePath'], protected=True)[0] != expected:
                    return unresolved
                raw, _ = read_file(item['configPath'], protected=True)
                value = sha(raw)
                if value == item['expectedSha256']:
                    selections.append('original')
                elif value == item['candidateSha256']:
                    selections.append('candidate')
                else:
                    return unresolved
                configs.append(json.loads(raw))
            before_raw = document('inventory-before.json', 16 * 1024 * 1024)
            before = json.loads(before_raw)
            if not isinstance(before, list) or len(before) != 2:
                return unresolved
            try:
                committed = document('commit.json')
            except FileNotFoundError:
                for check in locks: check()
                recheck()
                return {'kind': 'precommit-held', 'reason': 'commit-absent', 'configSelections': selections, 'inventorySha256': [sha(before_raw)]}
            if committed != commit or selections != ['candidate', 'candidate']:
                return unresolved
            after_raw = document('inventory-after.json', 16 * 1024 * 1024)
            after = json.loads(after_raw)
            if not isinstance(after, list) or len(after) != 2:
                return unresolved
            for old, new, config in zip(before, after, configs):
                preserved(old, new)
                verify_channel(config, volume_reader)
            # Live queues may legitimately advance after commit. Only the retained
            # preservation proof is compared, never old inventory to current queues.
            for check in locks: check()
            recheck()
            return {'kind': 'committed', 'reason': 'commit-confirmed', 'commitSha256': sha(commit), 'configSelections': selections, 'inventorySha256': [sha(before_raw), sha(after_raw)]}
    except (OSError, ValueError, KeyError, TypeError):
        return unresolved


def rollback_owned(plan, allowed_configs, original_job, rollback_job, indices):
    """Restoration primitive, not an executable or automatically dispatched path.

    A separate reviewed recovery must bind the original intent and completed-write
    identities. Missing write acknowledgements are uncertain, not rollback authority.
    Fences remain in place, including after successful restoration.
    """
    if not indices or len(indices) != len(set(indices)) or any(i not in (0, 1) for i in indices):
        raise ValueError('Invalid owned rollback selection')
    items = plan['brokers']
    paths = [item['configPath'] for item in items]
    if len(paths) != 2 or len(set(paths)) != 2 or set(paths) != set(allowed_configs):
        raise ValueError('Rollback target scope mismatch')
    original_job, rollback_job = Path(original_job), Path(rollback_job)
    with ExitStack() as stack:
        original_info, original_check = stack.enter_context(physical_directory(original_job))
        if original_info.st_uid != os.getuid() or stat.S_IMODE(original_info.st_mode) != 0o700:
            raise ValueError('Unprotected original evidence')
        info, check = stack.enter_context(physical_directory(rollback_job))
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Unprotected rollback evidence')
        locks = {path: stack.enter_context(broker_lock(Path(path).parent, create=False)) for path in sorted(paths)}
        intent = json.loads(read_file(original_job / 'intent.json', protected=True)[0])
        if intent != {'plan': plan, 'planSha256': sha(encode(plan))}:
            raise ValueError('Rollback intent does not belong to this plan')
        selected = []
        for index in indices:
            item = items[index]
            receipt = json.loads(read_file(original_job / ('replaced-' + str(index) + '.json'), protected=True)[0])
            current, current_info = read_file(item['configPath'], protected=True)
            if receipt != {'sha256': sha(current), 'identity': list(file_identity(current_info))} or sha(current) != item['candidateSha256']:
                raise ValueError('Rollback refuses foreign or changed selection')
            before, _ = read_file(original_job / ('original-' + str(index) + '.json'), protected=True)
            if sha(before) != item['expectedSha256']:
                raise ValueError('Rollback original changed')
            fence = json.loads(read_file(Path(item['configPath']).parent / FENCE, protected=True)[0])
            if fence['commitPath'] != str(original_job / 'commit.json') or fence['configSha256'] != item['candidateSha256']:
                raise ValueError('Rollback refuses foreign fence')
            selected.append((index, item, before, current_info))
        check()
        exclusive('intent.json', encode({'planSha256': sha(encode(plan)), 'indices': indices}), directory_fd=check.directory_fd)
        os.fsync(check.directory_fd)
        original_check()
        exclusive('rollback.pending.json', encode({'rollbackDirectory': str(rollback_job), 'planSha256': sha(encode(plan))}), directory_fd=original_check.directory_fd)
        os.fsync(original_check.directory_fd)
        for index, item, before, previous in selected:
            lock = locks[item['configPath']]
            lock()
            original_check()
            check()
            if file_identity(read_file(item['configPath'], protected=True)[1]) != file_identity(previous):
                raise ValueError('Rollback selection changed before effect')
            temporary = '.broker-rollback-' + plan['id'] + '-' + str(index)
            exclusive(temporary, before, stat.S_IMODE(previous.st_mode), lock.directory_fd)
            os.fsync(lock.directory_fd)
            staged, stage_info = read_file(Path(item['configPath']).parent / temporary, protected=True)
            if staged != before:
                raise ValueError('Rollback stage changed')
            lock()
            if file_identity(read_file(item['configPath'], protected=True)[1]) != file_identity(previous):
                raise ValueError('Rollback selection changed before effect')
            staged, now = read_file(Path(item['configPath']).parent / temporary, protected=True)
            if staged != before or file_identity(now) != file_identity(stage_info):
                raise ValueError('Rollback stage changed before effect')
            os.replace(temporary, Path(item['configPath']).name, src_dir_fd=lock.directory_fd, dst_dir_fd=lock.directory_fd)
            os.fsync(lock.directory_fd)
            if read_file(item['configPath'], protected=True)[0] != before:
                raise ValueError('Rollback readback changed')
            exclusive('restored-' + str(index) + '.json', encode({'sha256': sha(before), 'fenceRetained': True}), directory_fd=check.directory_fd)
            os.fsync(check.directory_fd)
        check()
        return {'restored': indices, 'fencesRetained': True}
