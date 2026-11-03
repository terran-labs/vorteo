"""Linux filesystem regressions, run inside the release Dev image by install CI."""
import importlib.util
import json
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('permissions', Path(__file__).with_name('projects-permissions.py'))
permissions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(permissions)


class ProjectsPermissionsTest(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(dir='/share'))
        self.folder.chmod(0o755)
        self.root = self.folder / 'projects'
        self.root.mkdir()
        os.chown(self.root, 1001, 2001)
        self.receipt = self.folder / 'receipt'
        self.receipt.touch(mode=0o600)
        self.fd = os.open(self.root, permissions.FLAGS | os.O_DIRECTORY)

    def tearDown(self):
        os.close(self.fd)
        shutil.rmtree(self.folder)

    def file(self, name, mode=0o644):
        target = self.root / name
        target.write_text('original')
        os.chown(target, 1001, 2001)
        target.chmod(mode)
        return target

    def acl(self, target):
        fd = os.open(target, permissions.FLAGS)
        try:
            return permissions.read_acl(fd)
        finally:
            os.close(fd)

    def prepare(self):
        return permissions.prepare(self.fd, self.receipt, [1000, 1001])

    def test_sharing_preserves_owners_special_bits_and_unrelated_access(self):
        target = self.file('file')
        readonly = self.file('readonly', 0o400)
        nested = self.root / 'nested'
        nested.mkdir()
        os.chown(nested, 1001, 2001)
        nested.chmod(0o2750)
        subprocess.run(['setfacl', '-m', 'u:3000:rwx,m:r--', target], check=True)
        external = self.folder / 'external'
        external.write_text('untouched')
        (self.root / 'link').symlink_to(external)
        original_external = self.acl(external)
        self.prepare()
        self.assertEqual((target.stat().st_uid, target.stat().st_gid), (1001, 2001))
        self.assertEqual(nested.stat().st_mode & 0o7000, 0o2000)
        self.assertEqual(self.acl(target)['access']['user:3000'], 4)
        self.assertEqual(self.acl(readonly)['access']['user:1000'], 4)
        self.assertEqual(self.acl(external), original_external)
        # Use real identities and restrictive umasks, not root's DAC override.
        for uid, script in [
            (1000, "umask 077; printf dev >> file; mkdir fromdev; printf dev > fromdev/file; test ! -w readonly"),
            (1001, "printf host >> fromdev/file; test \"$(cat fromdev/file)\" = devhost; mkdir fromhost; printf host > fromhost/file"),
            (1000, "printf dev >> fromhost/file; test \"$(cat fromhost/file)\" = hostdev"),
        ]:
            subprocess.run(['setpriv', f'--reuid={uid}', f'--regid={uid}', '--clear-groups',
                            'sh', '-c', script], cwd=self.root, check=True)

    def test_outside_hardlinks_and_special_files_fail_before_mutation(self):
        target = self.file('file')
        before = self.acl(self.root)
        os.link(target, self.folder / 'outside')
        with self.assertRaisesRegex(RuntimeError, 'hard links outside'):
            self.prepare()
        self.assertEqual(self.acl(self.root), before)
        (self.folder / 'outside').unlink()
        os.mkfifo(self.root / 'fifo')
        with self.assertRaisesRegex(RuntimeError, 'special file'):
            self.prepare()
        self.assertEqual(self.acl(self.root), before)
        self.assertEqual(self.receipt.read_text(), '')

    def test_same_filesystem_nested_mount_is_refused(self):
        before = self.acl(self.root)
        mounted = str(self.root / 'nested mount').replace(' ', r'\040')
        info = f'1 2 0:1 / {mounted} rw - ext4 /dev/test rw\n'
        original_open = open
        def mountinfo(name, *args, **kwargs):
            if name == '/proc/self/mountinfo':
                return io.StringIO(info)
            return original_open(name, *args, **kwargs)
        with patch('builtins.open', mountinfo):
            with self.assertRaisesRegex(RuntimeError, 'nested mount'):
                self.prepare()
        self.assertEqual(self.acl(self.root), before)
        self.assertEqual(self.receipt.read_text(), '')

    def test_failed_write_restores_acl_and_keeps_original_receipt(self):
        target = self.file('file')
        before = {str(p): self.acl(p) for p in [self.root, target]}
        write = permissions.write_acl
        calls = 0
        def interrupted(fd, acl):
            nonlocal calls
            calls += 1
            write(fd, acl)
            if calls == 3:
                raise RuntimeError('simulated interruption')
        with patch.object(permissions, 'write_acl', interrupted):
            with self.assertRaisesRegex(RuntimeError, 'simulated interruption'):
                self.prepare()
        for name, acl in before.items():
            self.assertEqual(self.acl(name), acl)
        events = [json.loads(line) for line in self.receipt.read_text().splitlines() if line]
        self.assertEqual(events[0]['state'], 'prepared')
        self.assertEqual(events[-1], {'state': 'rolled-back', 'retainedChanges': []})

    def test_recovery_preserves_intervening_acl_changes(self):
        target = self.file('file')
        self.prepare()
        data = json.loads(self.receipt.read_text().splitlines()[0])
        subprocess.run(['setfacl', '-m', 'u:3000:r--', target], check=True)
        changed = self.acl(target)
        self.assertEqual(permissions.recover(self.fd, self.receipt, data), ['file'])
        self.assertEqual(self.acl(target), changed)


if __name__ == '__main__':
    unittest.main()
