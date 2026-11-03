#!/usr/bin/env python3
"""Prepare Linux project sharing without changing owners or unrelated effective ACLs.

Run only in the installer's disposable, restricted helper container. Files are opened
relative to the mounted root, without following symlinks. Receipts are private Host
files, outside Projects. A quiet project tree is required; changed objects are refused.
"""
import collections
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

PERMS = ('---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx')
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def read_acl(fd):
    output = subprocess.check_output(
        ['getfacl', '-c', '-n', '-p', '--', f'/proc/self/fd/{fd}'],
        pass_fds=(fd,), text=True,
    )
    parts = {'access': {}, 'default': {}}
    for line in output.splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        fields = line.split(':')
        kind = 'default' if fields[0] == 'default' else 'access'
        if kind == 'default':
            fields = fields[1:]
        tag, qualifier, permissions = fields
        parts[kind][f'{tag}:{qualifier}'] = PERMS.index(permissions)
    return parts


def shared_acl(acl, uids, directory):
    """Add owner-equivalent rights, preserving unrelated effective ACL grants."""
    result = {}
    for kind, old in acl.items():
        if kind == 'default' and not directory:
            result[kind] = {}
            continue
        entries = dict(old or {'user:': 7, 'group:': 0, 'other:': 0})
        mask = entries.pop('mask:', 7)
        for key in entries:
            if key.startswith('group:') or (key.startswith('user:') and key != 'user:'):
                entries[key] &= mask
        for uid in uids:
            key = f'user:{uid}'
            entries[key] = entries.get(key, 0) | entries['user:']
        entries['mask:'] = 0
        for key, permissions in entries.items():
            if key.startswith('group:') or (key.startswith('user:') and key != 'user:'):
                entries['mask:'] |= permissions
        result[kind] = entries
    return result


def write_acl(fd, acl):
    target = f'/proc/self/fd/{fd}'
    for kind, entries in acl.items():
        if kind == 'default' and not stat.S_ISDIR(os.fstat(fd).st_mode):
            continue
        if entries:
            content = ''.join(f'{key}:{PERMS[value]}\n' for key, value in entries.items())
            subprocess.run(['setfacl', *(['-d'] if kind == 'default' else []),
                            '--set-file=-', '--', target], input=content, text=True,
                           pass_fds=(fd,), check=True, capture_output=True)
        elif kind == 'default':
            subprocess.run(['setfacl', '-k', '--', target], pass_fds=(fd,),
                           check=True, capture_output=True)


def identity(fd):
    info = os.fstat(fd)
    return [info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            stat.S_IFMT(info.st_mode), info.st_nlink, info.st_mode & 0o7000]


def open_relative(root, relative):
    current = os.dup(root)
    try:
        for part in relative.split('/') if relative else []:
            if part in ('', '.', '..'):
                raise RuntimeError('Invalid receipt path')
            following = os.open(part, FLAGS, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def save(receipt, value):
    # The Host precreates this private file. Updating it preserves its ownership.
    with open(receipt, 'a', encoding='utf8') as stream:
        if stream.tell():
            stream.write('\n')
        json.dump(value, stream)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def recover(root, receipt, data):
    retained = []
    for record in reversed(data['records']):
        try:
            fd = open_relative(root, record['path'])
            try:
                current = read_acl(fd)
                # An interrupted write can leave either access/default component
                # applied. Never overwrite an owner's intervening ACL change.
                expected = all(current[k] in (record['before'][k], record['after'][k])
                               for k in current)
                if identity(fd) != record['identity'] or not expected:
                    retained.append(record['path'])
                    continue
                if current != record['before']:
                    write_acl(fd, record['before'])
            finally:
                os.close(fd)
        except (OSError, subprocess.CalledProcessError):
            retained.append(record['path'])
    save(receipt, dict(state='rolled-back', retainedChanges=retained))
    return retained


def prepare(root, receipt, uids):
    records = []
    links = collections.Counter()
    seen = set()
    device = os.fstat(root).st_dev

    def visit(fd, relative):
        info = os.fstat(fd)
        directory = stat.S_ISDIR(info.st_mode)
        if info.st_dev != device or not (directory or stat.S_ISREG(info.st_mode)):
            raise RuntimeError(f'Cannot share a special file or separate filesystem: {relative}')
        if info.st_uid not in uids:
            raise RuntimeError(f'Projects contains a file owned by another account (UID {info.st_uid}): {relative}')
        key = (info.st_dev, info.st_ino)
        links[key] += 1
        if key not in seen:
            seen.add(key)
            before = read_acl(fd)
            after = shared_acl(before, uids, directory)
            if before != after:
                records.append(dict(path=relative, identity=identity(fd), before=before, after=after))
        if directory:
            for name in sorted(os.listdir(fd)):
                entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(entry.st_mode):
                    continue
                child = os.open(name, FLAGS, dir_fd=fd)
                try:
                    visit(child, f'{relative}/{name}' if relative else name)
                finally:
                    os.close(child)

    # Device IDs do not reveal bind mounts of another directory on the same disk.
    root_path = os.readlink(f'/proc/self/fd/{root}').rstrip('/')
    with open('/proc/self/mountinfo', encoding='utf8') as mounts:
        for line in mounts:
            mounted = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4])
            if mounted.startswith(root_path + '/'):
                raise RuntimeError(f'Projects contains a nested mount: {mounted}')

    # Probe ACL support on a disposable directory before changing existing data.
    probe = tempfile.mkdtemp(prefix='.vorteo-acl-probe-', dir='/share')
    try:
        fd = os.open(probe, FLAGS | os.O_DIRECTORY)
        try:
            expected = shared_acl(read_acl(fd), uids, True)
            write_acl(fd, expected)
            if read_acl(fd) != expected:
                raise RuntimeError('The Projects filesystem does not preserve POSIX ACLs')
        finally:
            os.close(fd)
    finally:
        os.rmdir(probe)
    visit(root, '')
    for record in records:
        device_id, inode, _, _, file_type, count, _ = record['identity']
        if file_type == stat.S_IFREG and links[(device_id, inode)] != count:
            raise RuntimeError(f'File has hard links outside Projects: {record["path"]}')
    data = dict(version=1, state='prepared', rootIdentity=identity(root)[:2],
                users=uids, records=records)
    save(receipt, data)
    try:
        for record in records:
            fd = open_relative(root, record['path'])
            try:
                if identity(fd) != record['identity'] or read_acl(fd) != record['before']:
                    raise RuntimeError(f'Projects changed while preparing permissions: {record["path"]}')
                write_acl(fd, record['after'])
                # setfacl must leave owner/group, inode and special mode bits intact.
                if identity(fd) != record['identity'] or read_acl(fd) != record['after']:
                    raise RuntimeError(f'Projects ACL verification failed: {record["path"]}')
            finally:
                os.close(fd)
    except BaseException:
        recover(root, receipt, data)
        raise
    save(receipt, dict(state='complete'))
    return len(records)


def main():
    action, receipt, *ids = sys.argv[1:]
    root = os.open('/share', FLAGS | os.O_DIRECTORY)
    try:
        if action == 'recover':
            with open(receipt, encoding='utf8') as stream:
                lines = stream.readlines()
            data = json.loads(lines[0])
            for line in lines[1:]:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if line.endswith('\n'):
                    data.update(event)
            if data['state'] == 'prepared':
                if data['rootIdentity'] != identity(root)[:2]:
                    raise RuntimeError('Projects root changed since the interrupted preparation')
                retained = recover(root, receipt, data)
                print(json.dumps({'recovered': True, 'retainedChanges': len(retained)}))
                if retained:
                    raise RuntimeError('Interrupted permissions include changed objects; inspect retainedChanges in the receipt before continuing')
            return
        uids = sorted({int(value) for value in ids})
        if len(uids) != 2 or min(uids) <= 0:
            raise RuntimeError('Sharing requires two distinct, non-root account IDs')
        print(json.dumps({'changed': prepare(root, receipt, uids)}))
    finally:
        os.close(root)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Cannot prepare shared Projects permissions: {error}', file=sys.stderr)
        sys.exit(1)
