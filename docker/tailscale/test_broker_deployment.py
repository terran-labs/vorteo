"""Consumer replacement keeps channel trust separate and refuses partial replay."""
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from broker_deployment import (FILES, deploy_files, directory_pin, encode, preservation, sha)
from channel_identity import NAMES, file_identity


class BrokerDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir(mode=0o700)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir(mode=0o700)
        self.targets = []
        self.originals = {}
        for index in range(2):
            root = self.root / str(index)
            root.mkdir(mode=0o700)
            channel = root / 'channel'
            channel.mkdir(mode=0o700)
            for name in NAMES[1:]:
                (channel / name).mkdir(mode=0o700)
            self.write(root / 'https-broker.lock', b'')
            self.write(root / 'https-broker-ledger.json', encode({'entries': {}, 'requests': {}}))
            self.write(channel / 'installed.json', encode({'version': 1, 'preserved': True}))
            self.write(root / 'host-config.json', encode({'deployment': str(root), 'channel': str(channel)}))
            files = {}
            for name in sorted(FILES):
                candidate = self.artifacts / f'{index}-{name}'
                self.write(candidate, b'candidate ' + name.encode())
                if name == 'channel_identity.py':
                    expected = {'kind': 'absent'}
                else:
                    self.write(root / name, b'legacy ' + name.encode())
                    expected = {'kind': 'present', 'sha256': sha((root / name).read_bytes()),
                                'identity': [str(value) for value in file_identity((root / name).stat())]}
                    self.originals[str(root / name)] = (root / name).read_bytes()
                files[name] = {'expected': expected, 'candidate': {'path': str(candidate),
                               'sha256': sha(candidate.read_bytes())}, 'mode': 0o600}
            self.targets.append({'root': str(root), 'directory': directory_pin(root.stat()),
                                 'files': files, 'preservationSha256': sha(encode(preservation(root)))})
        self.plan = {'version': 1, 'operation': 'preview-broker-consumer-deployment',
                     'id': str(uuid.uuid4()), 'evidenceDirectory': str(self.evidence),
                     'targets': self.targets}
        self.window = {'reservation': str(uuid.uuid4()), 'boot': str(uuid.uuid4()),
                       'suppressedRegistrations': ['fixture-host', 'fixture-dev']}

    def write(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def execute(self, **kwargs):
        return deploy_files(self.plan, [target['root'] for target in self.targets],
                            verify_window=lambda: self.window, **kwargs)

    def test_complete_pair_and_absent_verifiers(self):
        before = [preservation(Path(t['root'])) for t in self.targets]
        result = self.execute()
        self.assertEqual(result['kind'], 'files-committed')
        self.assertFalse(result['serviceStarted'])
        self.assertFalse(result['registrationsRestored'])
        self.assertEqual(before, [preservation(Path(t['root'])) for t in self.targets])
        commit = json.loads((self.evidence / 'commit.json').read_bytes())
        self.assertEqual(len(commit['files']), 8)
        for target in self.targets:
            for name, item in target['files'].items():
                self.assertEqual(sha((Path(target['root']) / name).read_bytes()), item['candidate']['sha256'])

    def test_wrong_preimage_has_no_intent_or_write(self):
        self.targets[1]['files']['https_broker.py']['expected']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'preimage'):
            self.execute()
        self.assertFalse((self.evidence / 'intent.json').exists())
        for name, raw in self.originals.items():
            self.assertEqual(Path(name).read_bytes(), raw)

    def test_late_absent_file_is_not_overwritten(self):
        def checkpoint(stage, index):
            if stage == 'before-write' and index == 0:
                self.write(Path(self.targets[0]['root']) / 'channel_identity.py', b'foreign')
        with self.assertRaisesRegex(ValueError, 'absent verifier'):
            self.execute(checkpoint=checkpoint)
        self.assertEqual((Path(self.targets[0]['root']) / 'channel_identity.py').read_bytes(), b'foreign')
        self.assertFalse((self.evidence / 'commit.json').exists())

    def test_revocation_after_first_write_stays_uncertain(self):
        def checkpoint(stage, index):
            if stage == 'after-write' and index == 0:
                self.window['reservation'] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'window changed'):
            self.execute(checkpoint=checkpoint)
        self.assertFalse((self.evidence / 'commit.json').exists())
        self.assertTrue((Path(self.targets[0]['root']) / 'channel_identity.py').exists())
        with self.assertRaises((ValueError, FileExistsError)):
            self.execute()

    def test_queue_removal_refuses_commit(self):
        channel = Path(self.targets[0]['root']) / 'channel'
        request = channel / 'inbox' / (str(uuid.uuid4()) + '.json')
        self.write(request, b'pending')
        self.targets[0]['preservationSha256'] = sha(encode(preservation(Path(self.targets[0]['root']))))
        def checkpoint(stage, index):
            if stage == 'after-write' and index == 7:
                request.unlink()
        with self.assertRaises(ValueError):
            self.execute(checkpoint=checkpoint)
        self.assertFalse((self.evidence / 'commit.json').exists())

    def test_no_window_is_not_admission(self):
        with self.assertRaisesRegex(ValueError, 'complete independent window'):
            deploy_files(self.plan, [t['root'] for t in self.targets], verify_window=lambda: True)
        self.assertEqual(list(self.evidence.iterdir()), [])


class NativeDeploymentTests(unittest.TestCase):
    """Actual worker and observer with synthetic native transport, no live service calls."""
    setUp = BrokerDeploymentTests.setUp
    write = BrokerDeploymentTests.write

    def native(self, dispositions=('loaded', 'absent'), enabled=(True, True)):
        import plistlib
        import subprocess
        from broker_deployment_observation import NativeObservation
        from broker_deployment_worker import Deployment
        boot = str(uuid.uuid4())
        states = []
        bindings = []
        registrations = []
        effects = []
        for index, target in enumerate(self.targets):
            root = Path(target['root'])
            label = f'local.test.broker{index}'
            argv = ['/protected/python', '-I', str(root / 'https_broker.py')]
            plist = self.artifacts / f'{label}.plist'
            raw = plistlib.dumps({'Label': label, 'ProgramArguments': argv, 'RunAtLoad': True, 'StartInterval': 10})
            self.write(plist, raw)
            binding = {'root': str(root), 'domain': f'gui/{os.getuid()}', 'label': label,
                       'plist': {'path': str(plist), 'sha256': sha(raw)}, 'interpreter': argv[0], 'argv': argv}
            bindings.append(binding)
            config = json.loads((root / 'host-config.json').read_bytes())
            config['brokerLabel'] = label
            config['channelIdentities'] = {name: [0, (Path(config['channel']) / name).stat().st_ino] for name in NAMES}
            self.write(root / 'host-config.json', encode(config))
            target['preservationSha256'] = sha(encode(preservation(root)))
            override = 'absent' if enabled[index] else 'disabled'
            registrations.append({key: binding[key] for key in ('root', 'domain', 'label', 'plist')} |
                                 {'disposition': dispositions[index], 'enabled': enabled[index], 'override': override, 'process': None})
            states.append({'loaded': dispositions[index] == 'loaded', 'override': None if enabled[index] else True})
        self.plan.update({'evidenceDirectoryIdentity': directory_pin(self.evidence.stat()), 'bootUUID': boot, 'registrations': registrations, 'manualParticipants': []})
        class Kernel:
            def boot(self): return boot
            def pids(self, uid): return []
            def info(self, pid): return {'pid': pid, 'parent': 1, 'uids': [os.getuid()] * 3, 'birth': [1, 2]}
            def argv(self, pid): return ['/bin/zsh']
        def invoke(argv):
            action = argv[1]
            domain = f'gui/{os.getuid()}'
            if action == 'print-disabled':
                raw = 'disabled services = {\n' + ''.join(f'\t"{b["label"]}" => {str(s["override"]).lower()}\n' for b,s in zip(bindings, states) if s['override'] is not None) + '}\n'
                return subprocess.CompletedProcess(argv, 0, raw, '')
            if action == 'print' and argv[2] == domain:
                return subprocess.CompletedProcess(argv, 0, domain + ' = {\n}\n', '')
            label = Path(argv[3]).stem if action == 'bootstrap' else argv[2].split('/')[-1]
            index = next(i for i,b in enumerate(bindings) if b['label'] == label)
            state = states[index]
            if action == 'print':
                if state['loaded']: return subprocess.CompletedProcess(argv, 0, domain+'/'+label+' = {\n}\n', '')
                return subprocess.CompletedProcess(argv, 113, '', f'Could not find service "{label}" in domain for user gui: {os.getuid()}\n')
            effects.append((index, action))
            if action == 'disable': state['override'] = True
            elif action == 'enable': state['override'] = False
            elif action == 'bootout': state['loaded'] = False
            elif action == 'bootstrap': state['loaded'] = True
            else: raise AssertionError('Unexpected native operation')
            return subprocess.CompletedProcess(argv, 0, '', '')
        guard = lambda: None
        observer = NativeObservation(self.plan, bindings, guard, kernel=Kernel(), invoke=invoke)
        packet = {'plan': self.plan, 'planSha256': sha(encode(self.plan)), 'bindings': bindings}
        worker = Deployment(packet, guard, observer=observer)
        return worker, observer, states, effects

    def test_actual_transition_and_readonly_recovery(self):
        worker, observer, states, effects = self.native()
        result = worker.execute()
        self.assertEqual(result['kind'], 'committed')
        self.assertEqual(effects, [(0,'disable'), (0,'bootout'), (1,'disable'), (0,'enable'), (0,'bootstrap'), (1,'enable')])
        before = list(effects)
        self.assertEqual(worker.observe()['kind'], 'committed')
        self.assertEqual(before, effects)
        with self.assertRaisesRegex(ValueError, "Prepared broker state changed"): worker.execute()
        self.assertEqual(before, effects)

    def test_recovery_anchors_baseline_to_approved_digest(self):
        root = self.targets[0]['root']
        request = Path(root) / 'channel' / 'inbox' / (str(uuid.uuid4()) + '.json')
        self.write(request, b'approved pending request')
        worker, observer, states, effects = self.native()
        self.assertEqual(worker.execute()['kind'], 'committed')
        # New inbox arrivals remain legitimate after commitment.
        added = request.with_name(str(uuid.uuid4()) + '.json')
        self.write(added, b'new pending request')
        self.assertEqual(worker.observe()['kind'], 'committed')
        before_path = self.evidence / 'before.json'
        receipt_path = self.evidence / 'deployment-commit.json'
        original_before = before_path.read_bytes()
        before = json.loads(original_before)
        before['innerPlanSha256'] = '0' * 64
        self.write(before_path, encode(before))
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        self.write(before_path, original_before)
        before = json.loads(original_before)
        receipt = json.loads(receipt_path.read_bytes())
        key = 'inbox/' + request.name
        del before['preservation'][root]['inventory'][key]
        for phase in ('baseline', 'after'):
            del receipt['preservationReport'][phase][root]['inventory'][key]
        receipt['preservationSha256'] = sha(encode(receipt['preservationReport']))
        self.write(before_path, encode(before))
        self.write(receipt_path, encode(receipt))
        request.unlink()
        self.assertEqual(worker.observe()['kind'], 'unresolved')

    def test_disabled_absent_stays_untouched(self):
        worker, observer, states, effects = self.native(('absent','absent'), (False,False))
        self.assertEqual(worker.execute()['kind'], 'committed')
        self.assertEqual(effects, [])

    def test_loaded_disabled_refuses_before_effect(self):
        worker, observer, states, effects = self.native(('loaded','absent'), (False,True))
        with self.assertRaisesRegex(ValueError, 'Loaded disabled'): worker.execute()
        self.assertEqual(effects, [])
        self.assertFalse((self.evidence / 'before.json').exists())

    def test_lost_bootout_response_never_replays_or_restores(self):
        worker, observer, states, effects = self.native()
        invoke = observer.invoke
        def lost(argv):
            result = invoke(argv)
            if argv[1] == 'bootout': raise TimeoutError('Lost after effect')
            return result
        observer.invoke = lost
        with self.assertRaises(TimeoutError): worker.execute()
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        self.assertEqual(effects, [(0,'disable'), (0,'bootout')])
        self.assertTrue((self.evidence / 'effect-0-bootout-intent.json').exists())
        self.assertFalse((self.evidence / 'intent.json').exists())

    def test_live_manual_generation_and_unknown_caller_refuse(self):
        worker, observer, states, effects = self.native()
        self.plan['manualParticipants'] = [{'pid': 42, 'birth': [1,2], 'uid': os.getuid(), 'argv': ['/python','-c','import broker']}]
        observer.process = lambda pid: self.plan['manualParticipants'][0]
        with self.assertRaisesRegex(ValueError, 'manual or waiting'): worker.execute()
        self.assertEqual(effects, [])

    def test_strict_native_diagnostics(self):
        from broker_deployment_observation import diagnostic, disabled_overrides
        for raw in ('disabled services = {\n', 'disabled services = {\n"a" => true\n"a" => false\n}', 'garbage'):
            with self.assertRaises(ValueError): disabled_overrides(raw, 'gui/501')
        for raw in ('gui/501/x = {\n', 'gui/501/x = {\n child = {\n\tpid = 42\n}\n}'):
            with self.assertRaises(ValueError): diagnostic(raw, 'gui/501/x', True)

    def test_unlisted_route_generation_refuses_before_mutation(self):
        worker, observer, states, effects = self.native()
        observer.kernel.pids = lambda uid: [42]
        observer.kernel.argv = lambda pid: observer.bindings[0]['argv']
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): worker.execute()
        self.assertEqual(effects, [])

    def test_mixed_uid_process_in_inventory_is_skipped(self):
        # loginwindow: effective UID is the owner, real and saved UIDs are root.
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        observer.kernel.pids = lambda owner: [416, 42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2],
                                            'uids': [uid, 0, 0] if pid == 416 else [uid] * 3}
        observer.kernel.argv = lambda pid: ['/System/Library/CoreServices/loginwindow'] if pid == 416 else ['/bin/zsh']
        observer.assert_no_unlisted([])
        observer.validate()
        # An owned route caller beside it still refuses.
        observer.kernel.argv = lambda pid: ['/System/Library/CoreServices/loginwindow'] if pid == 416 else observer.bindings[0]['argv']
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): observer.assert_no_unlisted([])
        self.assertEqual(effects, [])

    def test_mixed_uid_route_caller_refuses(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': [uid, 0, 0]}
        observer.kernel.argv = lambda pid: ['/python', observer.bindings[1]['argv'][2]]
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): observer.assert_no_unlisted([])
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): worker.execute()
        self.assertEqual(effects, [])

    def test_mixed_uid_broker_module_or_root_refuses(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': [uid, 0, 0]}
        for argv in (['/python', '-c', 'import channel_identity'],
                     ['/bin/cat', observer.bindings[0]['root'] + '/host-config.json']):
            observer.kernel.argv = lambda pid, argv=argv: argv
            with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): observer.assert_no_unlisted([])

    def test_mixed_to_owner_transition_across_sweeps_refuses(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        current = {'uids': [uid, 0, 0], 'argv': ['/usr/libexec/helper']}
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': current['uids']}
        observer.kernel.argv = lambda pid: current['argv']
        observer.assert_no_unlisted([])
        current.update(uids=[uid] * 3, argv=observer.bindings[0]['argv'])
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): observer.assert_no_unlisted([])

    def test_unreadable_mixed_uid_argv_refuses(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': [uid, 0, 0]}
        def denied(pid): raise PermissionError(1, 'Native arguments unavailable')
        observer.kernel.argv = denied
        with self.assertRaises(OSError): observer.assert_no_unlisted([])

    def test_credential_transition_during_inventory_refuses(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        reads = iter([[uid, 0, 0], [uid] * 3])
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': next(reads)}
        with self.assertRaisesRegex(ValueError, 'custody changed'): observer.assert_no_unlisted([])

    def test_vanished_inventory_process_is_ignored(self):
        from broker_deployment_kernel import ProcessGone
        worker, observer, states, effects = self.native()
        def gone(pid): raise ProcessGone(pid)
        observer.kernel.pids = lambda owner: [42]
        observer.kernel.info = gone
        observer.assert_no_unlisted([])

    def test_strict_custody_still_applies_to_participants(self):
        worker, observer, states, effects = self.native()
        uid = os.getuid()
        observer.kernel.info = lambda pid: {'pid': pid, 'parent': 1, 'birth': [1, 2], 'uids': [uid, 0, 0]}
        observer.kernel.argv = lambda pid: ['/python']
        with self.assertRaisesRegex(ValueError, 'custody changed'): observer.process(416)

    def test_boot_uuid_comparison_ignores_case(self):
        worker, observer, states, effects = self.native()
        self.plan['bootUUID'] = self.plan['bootUUID'].upper()
        self.assertEqual(observer.state(observer.bindings[0])['disposition'], 'loaded')
        self.plan['bootUUID'] = str(uuid.uuid4())
        with self.assertRaisesRegex(ValueError, 'boot changed'): observer.state(observer.bindings[0])

    def test_revoked_parent_guard_retains_suppression_without_files(self):
        worker, observer, states, effects = self.native()
        def guard():
            if effects: raise ValueError('Parent reservation revoked')
        observer.guard = guard
        worker.guard = guard
        with self.assertRaisesRegex(ValueError, 'reservation revoked'): worker.execute()
        self.assertEqual(effects, [(0, 'disable')])
        self.assertFalse((self.evidence / 'intent.json').exists())
        self.assertTrue(states[0]['override'])


    def test_captured_disabled_diagnostic_and_tampered_proofs(self):
        from broker_deployment_observation import disabled_overrides
        captured = '\n\tdisabled services = {\n\t\t"fixture.other.1" => enabled\n\t\t"fixture.other.2" => enabled\n\t\t"fixture.other.3" => disabled\n\t\t"fixture.other.4" => disabled\n\t\t"fixture.other.5" => disabled\n\t\t"fixture.other.6" => disabled\n\t\t"fixture.other.7" => disabled\n\t\t"fixture.other.8" => enabled\n\t\t"fixture.other.9" => enabled\n\t\t"fixture.other.10" => disabled\n\t\t"fixture.other.11" => disabled\n\t\t"fixture.other.12" => enabled\n\t\t"fixture.other.13" => disabled\n\t\t"fixture.other.14" => disabled\n\t\t"fixture.other.15" => enabled\n\t}\n'
        overrides = disabled_overrides(captured, 'gui/501')
        self.assertFalse(overrides['fixture.other.1'])
        self.assertTrue(overrides['fixture.other.3'])
        worker, observer, states, effects = self.native()
        self.assertEqual(worker.execute()['kind'], 'committed')
        receipt_path = self.evidence / 'deployment-commit.json'
        original = receipt_path.read_bytes()
        for key in ('registrationsSha256', 'preservationSha256'):
            changed = json.loads(original)
            changed[key] = '0' * 64
            self.write(receipt_path, encode(changed))
            self.assertEqual(worker.observe()['kind'], 'unresolved')
        changed = json.loads(original)
        changed['states'][0]['enabled'] = False
        changed['registrationsSha256'] = sha(encode(changed['states']))
        self.write(receipt_path, encode(changed))
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        changed = json.loads(original)
        changed['preservationReport']['baseline'] = {}
        changed['preservationSha256'] = sha(encode(changed['preservationReport']))
        self.write(receipt_path, encode(changed))
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        self.write(receipt_path, original)
        self.assertEqual(worker.observe()['kind'], 'committed')


if __name__ == '__main__':
    unittest.main()
