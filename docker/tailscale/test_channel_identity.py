import copy
import os
from pathlib import Path
import tempfile
import unittest
from channel_identity import ancestor_paths, NAMES, directory_identity, verify_channel


class ChannelIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.mount = Path(self.temp.name).resolve()
        self.channel = self.mount / 'channel'
        self.channel.mkdir(mode=0o700)
        for name in NAMES[1:]:
            (self.channel / name).mkdir(mode=0o700)
        self.volume = '7785796D-D4B1-445A-A2AD-B673A4DD6683'
        self.config = {'channel': str(self.channel), 'channelIdentities': {
            name: [(self.channel / name).stat().st_dev, (self.channel / name).stat().st_ino]
            for name in NAMES}}

    def migrate(self):
        self.config['channelFilesystemIdentity'] = {
            'version': 1, 'filesystem': 'apfs', 'volumeUUID': self.volume,
            'mountPoint': str(self.mount), 'ancestors': {p: directory_identity(Path(p).stat()) for p in ancestor_paths(self.channel, self.mount)}, 'directories': {
                name: directory_identity((self.channel / name).stat()) for name in NAMES}}

    def verify(self, reader=None):
        verify_channel(self.config, reader or (lambda _: self.volume))

    def test_legacy_refuses_device_drift(self):
        self.config['channelIdentities'][''][0] += 1
        with self.assertRaisesRegex(ValueError, 'administrator review'):
            self.verify()

    def test_explicit_stable_anchor_accepts_device_renumbering(self):
        self.migrate()
        for value in self.config['channelIdentities'].values():
            value[0] += 1
        self.verify()

    def test_wrong_volume_refuses_even_with_matching_inodes(self):
        self.migrate()
        with self.assertRaisesRegex(ValueError, 'volume identity changed'):
            self.verify(lambda _: '00000000-0000-0000-0000-000000000000')

    def test_missing_volume_evidence_refuses(self):
        self.migrate()
        def unavailable(_):
            raise OSError('unavailable')
        with self.assertRaises(OSError):
            self.verify(unavailable)

    def test_replaced_directory_refuses(self):
        self.migrate()
        (self.channel / 'inbox').rename(self.mount / 'old-inbox')
        (self.channel / 'inbox').mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            self.verify()

    def test_symlink_refuses(self):
        (self.channel / 'inbox').rename(self.mount / 'old-inbox')
        (self.channel / 'inbox').symlink_to(self.mount / 'old-inbox')
        with self.assertRaises(OSError):
            self.verify()

    def test_mode_or_owner_pin_change_refuses(self):
        self.migrate()
        for field in ('mode', 'uid', 'gid'):
            with self.subTest(field=field):
                original = copy.deepcopy(self.config)
                self.config['channelFilesystemIdentity']['directories']['inbox'][field] += 1
                with self.assertRaises(ValueError):
                    self.verify()
                self.config = original

    def test_late_ancestor_replacement_refuses(self):
        self.migrate()
        def replace(_):
            self.channel.rename(self.mount / 'previous')
            self.channel.mkdir(mode=0o700)
            return self.volume
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.verify(replace)

    def test_unknown_version_and_incomplete_anchor_refuse(self):
        self.migrate()
        self.config['channelFilesystemIdentity']['version'] = 2
        with self.assertRaises(ValueError):
            self.verify()
        self.config['channelFilesystemIdentity']['version'] = 1
        del self.config['channelFilesystemIdentity']['directories']['origins']
        with self.assertRaises(ValueError):
            self.verify()

    def test_request_addition_does_not_replace_directory_identity(self):
        self.migrate()
        def enqueue(_):
            (self.channel / 'inbox/request.json').write_text('{}')
            return self.volume
        self.verify(enqueue)
        self.assertEqual((self.channel / 'inbox/request.json').read_text(), '{}')

    def test_persisted_ancestor_replacement_pin_refuses(self):
        self.migrate()
        self.config['channelFilesystemIdentity']['ancestors'][str(self.mount)]['inode'] += 1
        with self.assertRaisesRegex(ValueError, 'Persisted ancestor'):
            self.verify()

    def test_directory_depth_is_bounded(self):
        from channel_identity import physical_directory
        with self.assertRaisesRegex(ValueError, 'Noncanonical'):
            with physical_directory('/' + '/'.join(['x'] * 21)):
                self.fail('unreachable')


if __name__ == '__main__':
    unittest.main()
