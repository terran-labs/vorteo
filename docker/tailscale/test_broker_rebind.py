import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
from broker_rebind import encode, migrate, rollback_owned, sha, snapshot, observe_outcome, coordinator_main
from channel_identity import ancestor_paths, NAMES, broker_lock, directory_identity


class BrokerRebindTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.volume = '7785796D-D4B1-445A-A2AD-B673A4DD6683'
        self.job = self.root / 'job'
        self.job.mkdir(mode=0o700)
        self.items, self.originals, self.configs = [], [], []
        for number in range(2):
            base = self.root / str(number)
            base.mkdir(mode=0o700)
            channel = base / 'channel'
            channel.mkdir(mode=0o700)
            for name in NAMES[1:]:
                (channel / name).mkdir(mode=0o700)
            (base / 'https-broker.lock').touch(mode=0o600)
            (base / 'https-broker-ledger.json').write_bytes(encode({'entries': {}, 'requests': {}}))
            config = {'deployment': str(base), 'channel': str(channel), 'hostname': 'preserved.test',
                      'channelIdentities': {name: [123, (channel / name).stat().st_ino] for name in NAMES}}
            anchor = {'version': 1, 'filesystem': 'apfs', 'volumeUUID': self.volume,
                      'mountPoint': str(self.root), 'ancestors': {p: directory_identity(Path(p).stat()) for p in ancestor_paths(channel, self.root)}, 'directories': {
                          name: directory_identity((channel / name).stat()) for name in NAMES}}
            raw = encode(config)
            path = base / 'host-config.json'
            path.write_bytes(raw)
            path.chmod(0o600)
            self.originals.append(raw)
            self.configs.append(config)
            self.items.append({'configPath': str(path), 'expectedSha256': sha(raw),
                               'candidateSha256': sha(encode({**config, 'channelFilesystemIdentity': anchor})),
                               'anchor': anchor, 'fencePath': str(base / 'https-broker-rebind.pending.json')})
        self.plan = {'version': 1, 'operation': 'preview-broker-channel-rebind',
                     'id': str(uuid.uuid4()), 'evidenceDirectory': str(self.job), 'brokers': self.items}

    def run_plan(self, **kwargs):
        return migrate(self.plan, [x['configPath'] for x in self.items], self.job,
                       volume_reader=lambda _: self.volume, **kwargs)

    def unchanged(self):
        self.assertEqual([Path(x['configPath']).read_bytes() for x in self.items], self.originals)

    def test_inventory_stops_enumerating_at_first_over_limit_entry(self):
        yielded = []
        def oversized(directory):
            for index in range(4097):
                yielded.append(index)
                yield directory / str(index)
            raise AssertionError('Enumeration exceeded the fixed inventory bound')
        with patch.object(Path, 'iterdir', oversized):
            with self.assertRaisesRegex(ValueError, 'inventory exceeds bound'):
                snapshot(self.configs[0])
        self.assertEqual(len(yielded), 4097)
        self.unchanged()

    def test_success_preserves_queues_ledger_and_other_config(self):
        pending = Path(self.configs[0]['channel']) / 'inbox' / (str(uuid.uuid4()) + '.json')
        pending.write_bytes(b'{"untouched":true}')
        inode = pending.stat().st_ino
        result = self.run_plan()
        self.assertEqual(result['status'], 'succeeded')
        self.assertFalse(result['serviceStarted'])
        self.assertEqual(pending.read_bytes(), b'{"untouched":true}')
        self.assertEqual(pending.stat().st_ino, inode)
        for index, item in enumerate(self.items):
            current = json.loads(Path(item['configPath']).read_bytes())
            current.pop('channelFilesystemIdentity')
            self.assertEqual(current, self.configs[index])
            self.assertEqual((self.job / ('original-' + str(index) + '.json')).read_bytes(), self.originals[index])

    def test_hash_cas_refuses_before_write(self):
        self.items[1]['expectedSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'compare-and-swap'):
            self.run_plan()
        self.unchanged()
        self.assertEqual(list(self.job.iterdir()), [])

    def test_candidate_hash_refuses_unreviewed_metadata(self):
        self.items[0]['anchor']['volumeUUID'] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'Candidate digest'):
            self.run_plan()
        self.unchanged()

    def test_wrong_volume_refuses_before_intent(self):
        self.volume = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'volume identity'):
            self.run_plan()
        self.unchanged()
        self.assertEqual(list(self.job.iterdir()), [])

    def test_cancellation_before_preparation(self):
        with self.assertRaisesRegex(ValueError, 'Cancelled'):
            self.run_plan(cancelled=lambda: True)
        self.unchanged()
        self.assertEqual(list(self.job.iterdir()), [])

    def test_cancellation_between_configs_retains_first(self):
        cancel = [False]
        def checkpoint(stage, index):
            if stage == 'after-replace' and index == 0:
                cancel[0] = True
        with self.assertRaisesRegex(ValueError, 'Cancelled'):
            self.run_plan(cancelled=lambda: cancel[0], checkpoint=checkpoint)
        self.assertEqual(sha(Path(self.items[0]['configPath']).read_bytes()), self.items[0]['candidateSha256'])
        self.assertEqual(Path(self.items[1]['configPath']).read_bytes(), self.originals[1])
        self.assertTrue((self.job / 'replaced-0.json').exists())
        self.assertFalse((self.job / 'verified.json').exists())

    def test_second_rename_failure_retains_partial_without_retry(self):
        replace = os.replace
        def fail(source, destination, **kwargs):
            if source.endswith('-1'):
                raise OSError('disk failure')
            return replace(source, destination, **kwargs)
        with patch('broker_rebind.os.replace', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                self.run_plan()
        self.assertTrue((self.job / 'replaced-0.json').exists())
        self.assertTrue((self.job / 'replace-intent-1.json').exists())
        with self.assertRaises(ValueError):
            self.run_plan()
        self.assertEqual(Path(self.items[1]['configPath']).read_bytes(), self.originals[1])

    def test_crash_after_rename_retains_uncertain_intent(self):
        def crash(stage, index):
            if stage == 'after-replace' and index == 0:
                raise SystemExit('crash')
        with self.assertRaises(SystemExit):
            self.run_plan(checkpoint=crash)
        self.assertTrue((self.job / 'replace-intent-0.json').exists())
        self.assertFalse((self.job / 'replaced-0.json').exists())
        self.assertEqual(sha(Path(self.items[0]['configPath']).read_bytes()), self.items[0]['candidateSha256'])
        with self.assertRaises(ValueError):
            self.run_plan()

    def test_full_disk_retains_intent_without_config_writes(self):
        with patch('broker_rebind.os.fsync', side_effect=OSError('full disk')):
            with self.assertRaises(OSError):
                self.run_plan()
        self.unchanged()
        self.assertTrue((self.job / 'intent.json').exists())

    def test_concurrent_addition_accounted_without_consuming(self):
        name = str(uuid.uuid4()) + '.json'
        def add(stage, index):
            if stage == 'prepared':
                (Path(self.configs[0]['channel']) / 'inbox' / name).write_bytes(b'{}')
        result = self.run_plan(checkpoint=add)
        self.assertEqual(result['concurrentRequests'], [['inbox/' + name], []])
        self.assertEqual((Path(self.configs[0]['channel']) / 'inbox' / name).read_bytes(), b'{}')

    def test_existing_request_edit_stops_before_replacement(self):
        request = Path(self.configs[0]['channel']) / 'inbox' / (str(uuid.uuid4()) + '.json')
        request.write_bytes(b'{}')
        def edit(stage, index):
            if stage == 'prepared':
                request.write_bytes(b'{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'channel or ledger changed'):
            self.run_plan(checkpoint=edit)
        self.unchanged()

    def test_consumed_without_receipt_refuses(self):
        ledger = Path(self.configs[0]['deployment']) / 'https-broker-ledger.json'
        ledger.write_bytes(encode({'entries': {}, 'requests': {str(uuid.uuid4()): 1}}))
        with self.assertRaisesRegex(ValueError, 'Indeterminate'):
            self.run_plan()
        self.unchanged()

    def test_pending_start_refuses(self):
        ledger = Path(self.configs[0]['deployment']) / 'https-broker-ledger.json'
        ledger.write_bytes(encode({'entries': {'x': {'status': 'pending'}}, 'requests': {}}))
        with self.assertRaisesRegex(ValueError, 'Pending broker start'):
            self.run_plan()
        self.unchanged()

    def test_consumer_lock_blocks_migration(self):
        with broker_lock(Path(self.items[1]['configPath']).parent):
            with self.assertRaises(BlockingIOError):
                self.run_plan()
        self.unchanged()

    def test_late_config_edit_refuses_cas(self):
        def edit(stage, index):
            if stage == 'before-replace':
                Path(self.items[index]['configPath']).write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'changed before replacement'):
            self.run_plan(checkpoint=edit)
        self.assertEqual(Path(self.items[0]['configPath']).read_bytes(), b'{}')
        self.assertEqual(Path(self.items[1]['configPath']).read_bytes(), self.originals[1])


    def test_late_staged_bytes_refuse_before_live_config(self):
        def edit(stage, index):
            if stage == 'before-replace':
                temporary = Path(self.items[index]['configPath']).with_name('.broker-rebind-' + self.plan['id'] + '-' + str(index))
                temporary.write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'Staged config changed before'):
            self.run_plan(checkpoint=edit)
        self.unchanged()

    def test_partial_apply_fences_real_consumer_without_runtime_effect(self):
        from https_broker import Broker
        from unittest.mock import Mock
        def crash(stage, index):
            if stage == 'after-replace' and index == 0:
                raise SystemExit('crash')
        with self.assertRaises(SystemExit):
            self.run_plan(checkpoint=crash)
        for item in self.items:
            runtime = Mock()
            broker = Broker(json.loads(Path(item['configPath']).read_bytes()), runtime=runtime)
            with self.assertRaisesRegex(ValueError, 'migration incomplete'):
                broker.run()
            self.assertEqual(runtime.mock_calls, [])
        self.assertTrue((self.job / 'inventory-before.json').exists())

    def test_commit_releases_fences_only_after_complete_pair(self):
        from channel_identity import verify_fence
        self.run_plan()
        for item in self.items:
            verify_fence(json.loads(Path(item['configPath']).read_bytes()))
        self.assertTrue((self.job / 'inventory-after.json').exists())
        (self.job / 'commit.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'commit changed'):
            verify_fence(json.loads(Path(self.items[0]['configPath']).read_bytes()))

    def test_missing_fence_never_activates_migrated_config(self):
        from channel_identity import verify_fence
        self.run_plan()
        Path(self.items[0]['fencePath']).unlink()
        with self.assertRaisesRegex(ValueError, 'missing its activation fence'):
            verify_fence(json.loads(Path(self.items[0]['configPath']).read_bytes()))

    def test_changed_fence_blocks_commit_after_verified_evidence(self):
        def checkpoint(stage, index):
            if stage == 'before-commit':
                Path(self.items[0]['fencePath']).write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError, 'Activation fence changed'):
            self.run_plan(checkpoint=checkpoint)
        self.assertTrue((self.job / 'verified.json').exists())
        self.assertFalse((self.job / 'commit.json').exists())

    def test_created_job_identity_is_bound_before_any_write(self):
        with self.assertRaisesRegex(ValueError, 'job directory was replaced'):
            self.run_plan(expected_job_identity=(self.job.stat().st_dev, -1))
        self.unchanged()
        self.assertEqual(list(self.job.iterdir()), [])

    def observe(self):
        # Production names the request directory by UUID; the fixture explicitly
        # maps its existing job into that same shape before any observation.
        return observe_outcome(self.plan, [x['configPath'] for x in self.items], self.root,
                               volume_reader=lambda _: self.volume)

    def observation_layout(self):
        target = self.root / self.plan['id']
        self.job.rename(target)
        self.job = target
        self.plan['evidenceDirectory'] = str(target)

    def test_observation_requires_commit_not_verified_receipt(self):
        self.observation_layout()
        def stop(stage, index):
            if stage == 'before-commit': raise RuntimeError('lost worker')
        with self.assertRaises(RuntimeError): self.run_plan(checkpoint=stop)
        self.assertTrue((self.job / 'verified.json').exists())
        before = {p.name: p.read_bytes() for p in self.job.iterdir()}
        result = self.observe()
        self.assertEqual(result['kind'], 'precommit-held')
        self.assertEqual(result['configSelections'], ['candidate', 'candidate'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.job.iterdir()})

    def test_committed_observation_allows_later_legitimate_queue_progress(self):
        self.observation_layout()
        self.run_plan()
        (Path(self.configs[0]['channel']) / 'receipts' / 'later.json').write_bytes(b'{}')
        result = self.observe()
        self.assertEqual(result['kind'], 'committed')
        self.assertEqual(result['commitSha256'], sha((self.job / 'commit.json').read_bytes()))
        self.assertEqual(len(result['inventorySha256']), 2)

    def test_observation_refuses_foreign_commit_or_intent(self):
        self.observation_layout()
        self.run_plan()
        (self.job / 'commit.json').write_bytes(b'{}')
        self.assertEqual(self.observe()['kind'], 'unresolved')
        (self.job / 'intent.json').write_bytes(b'{}')
        self.assertEqual(self.observe()['kind'], 'unresolved')

    def test_missing_evidence_observation_creates_nothing(self):
        self.plan['evidenceDirectory'] = str(self.root / self.plan['id'])
        self.assertEqual(self.observe()['kind'], 'unresolved')
        self.assertFalse(Path(self.plan['evidenceDirectory']).exists())

    def test_observation_digest_bridge_preserves_exact_approved_json_bytes(self):
        from types import SimpleNamespace
        self.plan['reason'] = 'Unicode: café'
        approved = json.dumps(self.plan, ensure_ascii=False, separators=(',', ':'))
        request = {'operation': 'observe', 'plan': self.plan, 'approvedPlanBytes': approved,
                   'approvedPlanSha256': sha(approved.encode()), 'allowedConfigs': [], 'evidenceRoot': str(self.root)}
        output = io.StringIO()
        with patch('sys.stdin', SimpleNamespace(buffer=io.BytesIO(encode(request)))), patch('sys.stdout', output), patch('signal.alarm'), patch('broker_rebind.observe_outcome', return_value={'kind': 'unresolved', 'reason': 'evidence-unconfirmed'}):
            coordinator_main()
        result = json.loads(output.getvalue())
        self.assertEqual(result['planSha256'], sha(approved.encode()))
        self.assertEqual(result['workerPlanSha256'], sha(encode(self.plan)))
        self.assertNotEqual(result['planSha256'], result['workerPlanSha256'])

    def test_owned_only_rollback_preserves_fences_and_refuses_foreign_inode(self):
        self.run_plan()
        rollback = self.root / 'rollback'
        rollback.mkdir(mode=0o700)
        allowed = [item['configPath'] for item in self.items]
        result = rollback_owned(self.plan, allowed, self.job, rollback, [0])
        self.assertEqual(result, {'restored': [0], 'fencesRetained': True})
        self.assertEqual(Path(self.items[0]['configPath']).read_bytes(), self.originals[0])
        self.assertTrue(Path(self.items[0]['fencePath']).exists())
        second = Path(self.items[1]['configPath'])
        foreign = second.with_name('foreign')
        foreign.write_bytes(second.read_bytes())
        foreign.chmod(0o600)
        foreign.replace(second)
        another = self.root / 'other-rollback'
        another.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'foreign or changed'):
            rollback_owned(self.plan, allowed, self.job, another, [1])
        self.assertEqual(list(another.iterdir()), [])

    def test_replaced_evidence_ancestor_cannot_redirect_writes(self):
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        def replace(stage, index):
            if stage == 'prepared':
                self.job.rename(self.root / 'retained-job')
                self.job.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_plan(checkpoint=replace)
        self.assertEqual(list(outside.iterdir()), [])
        self.unchanged()

    def test_evidence_writes_use_retained_fd_after_last_path_check(self):
        import broker_rebind
        real = broker_rebind.exclusive
        outside = self.root / 'outside'
        outside.mkdir(mode=0o700)
        def substitute(path, data, mode=0o600, directory_fd=None):
            if path == 'inventory-before.json':
                self.job.rename(self.root / 'retained-job')
                self.job.symlink_to(outside, target_is_directory=True)
            return real(path, data, mode, directory_fd)
        with patch('broker_rebind.exclusive', side_effect=substitute):
            with self.assertRaises(ValueError):
                self.run_plan()
        self.assertEqual(list(outside.iterdir()), [])
        self.assertTrue((self.root / 'retained-job' / 'inventory-before.json').exists())
        self.unchanged()

    def test_partial_rollback_keeps_both_consumers_fenced(self):
        from channel_identity import verify_fence
        self.run_plan()
        rollback = self.root / 'rollback'
        rollback.mkdir(mode=0o700)
        rollback_owned(self.plan, [x['configPath'] for x in self.items], self.job, rollback, [0])
        for item in self.items:
            with self.assertRaisesRegex(ValueError, 'rollback requires'):
                verify_fence(json.loads(Path(item['configPath']).read_bytes()))


if __name__ == '__main__':
    unittest.main()
