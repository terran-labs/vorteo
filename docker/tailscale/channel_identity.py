"""Read-only channel verification; migration must be explicitly admitted elsewhere."""
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import resource
import stat
import subprocess
import tempfile
import uuid

NAMES = ('', 'inbox', 'receipts', 'origins')
FENCE = 'https-broker-rebind.pending.json'


def apfs_volume(mount):
    def bound():
        resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536))
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', str(mount)],
                       check=True, stdout=out, stderr=err, timeout=5, preexec_fn=bound)
        if out.tell() >= 65536 or err.tell() >= 65536:
            raise ValueError('Volume evidence exceeds bound')
        out.seek(0)
        info = plistlib.loads(out.read(65536))
    if info.get('FilesystemType') != 'apfs' or info.get('MountPoint') != str(mount):
        raise ValueError('Unattested APFS mount')
    return str(uuid.UUID(info['VolumeUUID'])).upper()


def directory_identity(info):
    return {'inode': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode)}


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_file(path, limit=2 * 1024 * 1024, protected=False):
    path = Path(path)
    with physical_directory(path.parent):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
                raise ValueError('Unsafe file or size bound exceeded')
            if protected and (before.st_uid != os.getuid() or before.st_mode & 0o022):
                raise ValueError('Unprotected broker file')
            data = bytearray()
            while len(data) <= limit:
                part = os.read(fd, min(65536, limit + 1 - len(data)))
                if not part:
                    break
                data.extend(part)
            if len(data) > limit or len(data) != before.st_size:
                raise ValueError('File size changed')
            if file_identity(before) != file_identity(os.fstat(fd)) or file_identity(before) != file_identity(path.lstat()):
                raise ValueError('File changed during read')
            return bytes(data), before
        finally:
            os.close(fd)


@contextmanager
def broker_lock(root, create=True):
    """All consumers and the migration use this same retained lock inode."""
    root = Path(root)
    with physical_directory(root) as (_, recheck):
        path = root / 'https-broker.lock'
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
        fd = os.open(path, flags | (os.O_CREAT if create else 0), 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Unsafe broker lock')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def check():
                recheck()
                if file_identity(info) != file_identity(os.fstat(fd)) or file_identity(info) != file_identity(path.lstat()):
                    raise ValueError('Broker lock changed')
            check.directory_fd = recheck.directory_fd
            check()
            yield check
            check()
        finally:
            os.close(fd)


@contextmanager
def physical_directory(path):
    path = Path(path)
    if not path.is_absolute() or path != Path(os.path.normpath(path)) or len(path.parts) > 20 or len(str(path)) > 4096:
        raise ValueError('Noncanonical directory')
    with ExitStack() as stack:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        stack.callback(os.close, fd)
        opened = [(Path('/'), fd, os.fstat(fd))]
        current = Path('/')
        for part in path.parts[1:]:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            stack.callback(os.close, fd)
            current /= part
            opened.append((current, fd, os.fstat(fd)))

        def recheck():
            for name, descriptor, before in opened:
                now = os.fstat(descriptor)
                visible = name.lstat()
                expected = (before.st_dev, directory_identity(before))
                if (now.st_dev, directory_identity(now)) != expected or (
                        visible.st_dev, directory_identity(visible)) != expected:
                    raise ValueError('Directory or ancestor changed')
                if not stat.S_ISDIR(visible.st_mode):
                    raise ValueError('Directory replaced')

        recheck.directory_fd = fd
        recheck()
        yield os.fstat(fd), recheck
        recheck()


def ancestor_paths(channel, mount):
    return sorted({str(p) for base in (Path(channel), Path(mount)) for p in base.parents})


def verify_fence(config):
    """A partial pair remains fenced after locks/processes disappear.

    One exact commit record releases both consumers only after both configs and
    all preservation proofs were verified. No unlink is needed to clear a fence.
    """
    path = Path(config['deployment']) / FENCE
    try:
        raw, _ = read_file(path, 65536, protected=True)
    except FileNotFoundError:
        if 'channelFilesystemIdentity' in config:
            raise ValueError('Migrated broker is missing its activation fence')
        return
    fence = json.loads(raw)
    if set(fence) != {'version', 'commitPath', 'commitSha256', 'configPath', 'configSha256'} or fence['version'] != 1:
        raise ValueError('Invalid broker migration fence')
    if fence['configPath'] != str(Path(config['deployment']) / 'host-config.json'):
        raise ValueError('Foreign broker migration fence')
    try:
        (Path(fence['commitPath']).parent / 'rollback.pending.json').lstat()
    except FileNotFoundError:
        pass
    else:
        raise ValueError('Broker rollback requires administrator disposition')
    try:
        commit, _ = read_file(fence['commitPath'], 65536, protected=True)
    except FileNotFoundError:
        raise ValueError('Broker migration incomplete; administrator review required') from None
    if hashlib.sha256(commit).hexdigest() != fence['commitSha256']:
        raise ValueError('Broker migration commit changed')
    value = json.loads(commit)
    if value.get('configs', {}).get(fence['configPath']) != fence['configSha256']:
        raise ValueError('Broker commit does not bind this config')
    current, _ = read_file(fence['configPath'], 65536, protected=True)
    if hashlib.sha256(current).hexdigest() != fence['configSha256'] or json.loads(current) != config:
        raise ValueError('Broker committed selection changed')


def verify_channel(config, volume_reader=apfs_volume):
    channel = Path(config['channel'])
    legacy = config['channelIdentities']
    if set(legacy) != set(NAMES):
        raise ValueError('Incomplete channel identity')
    anchor = config.get('channelFilesystemIdentity')
    if anchor is not None:
        if set(anchor) != {'version', 'filesystem', 'volumeUUID', 'mountPoint', 'directories', 'ancestors'}:
            raise ValueError('Invalid filesystem identity fields')
        if anchor['version'] != 1 or anchor['filesystem'] != 'apfs':
            raise ValueError('Unsupported filesystem identity')
        if set(anchor['directories']) != set(NAMES):
            raise ValueError('Incomplete stable directory identity')
        expected_uuid = str(uuid.UUID(anchor['volumeUUID'])).upper()
        mount = Path(anchor['mountPoint'])
        if set(anchor['ancestors']) != set(ancestor_paths(channel, mount)):
            raise ValueError('Incomplete persisted ancestry')
        if channel != mount and mount not in channel.parents:
            # macOS firmlinks expose Data paths under /Users. Device equality below
            # binds that exposure to the attested mount, without following links.
            if mount != Path('/System/Volumes/Data') or channel.parts[:2] != ('/', 'Users'):
                raise ValueError('Channel outside attested mount')
    with ExitStack() as stack:
        opened = {name: stack.enter_context(physical_directory(channel / name)) for name in NAMES}
        if anchor is None:
            for name, (info, _) in opened.items():
                if [info.st_dev, info.st_ino] != legacy[name]:
                    raise ValueError('Request channel replaced; administrator review required')
            return
        mount_info, recheck_mount = stack.enter_context(physical_directory(mount))
        for path, pin in anchor['ancestors'].items():
            with physical_directory(path) as (info, _):
                if directory_identity(info) != pin:
                    raise ValueError('Persisted ancestor identity changed')
        for name, (info, _) in opened.items():
            pin = anchor['directories'][name]
            if set(pin) != {'inode', 'uid', 'gid', 'mode'} or directory_identity(info) != pin:
                raise ValueError('Stable channel identity changed')
            if info.st_mode & 0o022 or info.st_dev != mount_info.st_dev:
                raise ValueError('Unsafe channel filesystem or permissions')
            if info.st_ino != legacy[name][1]:
                raise ValueError('Migration changed channel inode')
        if volume_reader(mount) != expected_uuid:
            raise ValueError('APFS volume identity changed')
        recheck_mount()
        for _, recheck in opened.values():
            recheck()
