"""Consumer replacement keeps channel trust separate and refuses partial replay."""
import json
import re
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from broker_deployment import (FILES, approved_preservation_sha256, deploy_files, directory_pin, encode, preservation, sha)
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

    def native(self, dispositions=('loaded', 'absent'), enabled=(True, True), running=False,
               interpreter='/protected/python', image=None):
        """running: legacy pins verify and each loaded scheduler has a live generation."""
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
            argv = [interpreter, '-I', str(root / 'https_broker.py')]
            plist = self.artifacts / f'{label}.plist'
            raw = plistlib.dumps({'Label': label, 'ProgramArguments': argv, 'RunAtLoad': True, 'StartInterval': 10})
            self.write(plist, raw)
            binding = {'root': str(root), 'domain': f'gui/{os.getuid()}', 'label': label,
                       'plist': {'path': str(plist), 'sha256': sha(raw)}, 'interpreter': argv[0], 'argv': argv}
            bindings.append(binding)
            config = json.loads((root / 'host-config.json').read_bytes())
            config['brokerLabel'] = label
            config['channelIdentities'] = {name: [(Path(config['channel']) / name).stat().st_dev if running else 0,
                                                  (Path(config['channel']) / name).stat().st_ino] for name in NAMES}
            self.write(root / 'host-config.json', encode(config))
            target['preservationSha256'] = approved_preservation_sha256(preservation(root), 'running' if running else 'refusing')
            override = 'absent' if enabled[index] else 'disabled'
            registrations.append({key: binding[key] for key in ('root', 'domain', 'label', 'plist')} |
                                 {'disposition': dispositions[index], 'enabled': enabled[index], 'override': override, 'process': None} |
                                 # Refusing fixtures omit the field, as plans made before running admission did.
                                 ({'admission': 'running'} if running else {}))
            states.append({'loaded': dispositions[index] == 'loaded', 'override': None if enabled[index] else True})
        self.plan.update({'evidenceDirectoryIdentity': directory_pin(self.evidence.stat()), 'bootUUID': boot, 'registrations': registrations, 'manualParticipants': []})
        # A running scheduler's generation is pid 40 + index while its job is loaded.
        # image: argv[0] a live generation reports, such as a framework launcher's re-exec.
        live = lambda: {40 + i: [image or b['argv'][0]] + b['argv'][1:]
                        for i, (b, s) in enumerate(zip(bindings, states)) if running and s['loaded']}
        class Kernel:
            def boot(self): return boot
            def pids(self, uid): return list(live())
            def info(self, pid): return {'pid': pid, 'parent': 1, 'uids': [os.getuid()] * 3, 'birth': [1, 2]}
            def argv(self, pid): return live().get(pid, ['/bin/zsh'])
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
                pid = f'\tpid = {40 + index}\n' if running and state['loaded'] else ''
                if state['loaded']: return subprocess.CompletedProcess(argv, 0, domain+'/'+label+' = {\n'+pid+'}\n', '')
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
        worker.settle_seconds = 0.5
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

    def test_running_brokers_are_admitted_after_suppression(self):
        # Hand-repaired legacy pins verify, so the brokers serve requests and keep
        # rewriting their ledgers after the plan was prepared.
        worker, observer, states, effects = self.native(running=True)
        ledger = Path(self.targets[0]['root']) / 'https-broker-ledger.json'
        self.write(ledger, encode({'entries': {}, 'requests': {}, 'reconcileCursor': 1}))
        self.assertEqual(worker.execute()['kind'], 'committed')
        self.assertEqual(effects, [(0,'disable'), (0,'bootout'), (1,'disable'), (0,'enable'), (0,'bootstrap'), (1,'enable')])
        admission = json.loads((self.evidence / 'admission.json').read_bytes())
        self.assertEqual(admission['admission'], ['running', 'running'])
        self.assertEqual(worker.observe()['kind'], 'committed')

    FRAMEWORK = '/opt/fixture/Python.framework/Versions/3.14'

    def test_framework_launcher_generation_is_admitted(self):
        # launchd runs bin/python3.14, which re-executes Python.app as argv[0].
        worker, observer, states, effects = self.native(
            running=True, interpreter=self.FRAMEWORK + '/bin/python3.14',
            image=self.FRAMEWORK + '/Resources/Python.app/Contents/MacOS/Python')
        self.assertEqual(worker.execute()['kind'], 'committed')
        self.assertEqual(worker.observe()['kind'], 'committed')

    def test_foreign_interpreter_running_the_route_is_refused(self):
        from broker_deployment_observation import route_argv
        launcher = self.FRAMEWORK + '/bin/python3.14'
        binding = {'interpreter': launcher, 'argv': [launcher, '-I', '/root/https_broker.py']}
        for argv0 in ('/usr/bin/python3', '/opt/fixture/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python',
                      self.FRAMEWORK + '/Resources/Python.app/Contents/MacOS/Python3'):
            self.assertFalse(route_argv([argv0, '-I', '/root/https_broker.py'], binding))
        image = self.FRAMEWORK + '/Resources/Python.app/Contents/MacOS/Python'
        self.assertTrue(route_argv([image, '-I', '/root/https_broker.py'], binding))
        # Only argv[0] may differ: extra, missing or reordered arguments are refused.
        for argv in ([image, '-I', '/root/https_broker.py', '--extra'], [image, '/root/https_broker.py', '-I'],
                     [image, '-I'], [image, '-c', 'import os', '/root/https_broker.py'],
                     [launcher, '/root/https_broker.py', '-I'], [launcher, '-I', '/root/https_broker.py', '-x']):
            self.assertFalse(route_argv(argv, binding), argv)
        # A non-framework interpreter has no re-exec image to admit.
        self.assertFalse(route_argv(['/x', '-I', '/r/https_broker.py'], {'interpreter': '/protected/python', 'argv': ['/protected/python', '-I', '/r/https_broker.py']}))
        worker, observer, states, effects = self.native(running=True, interpreter=launcher, image='/usr/bin/python3')
        with self.assertRaisesRegex(ValueError, 'differs from protected route'): worker.execute()
        self.assertEqual(effects, [])

    def churn(self, root, cursor):
        """What a restored running broker does every cycle: rewrite its ledger."""
        self.write(Path(root) / 'https-broker-ledger.json', encode({'entries': {}, 'requests': {}, 'reconcileCursor': cursor}))

    def test_running_broker_rewriting_ledger_after_restore_confirms(self):
        worker, observer, states, effects = self.native(running=True)
        root = self.targets[0]['root']
        record = worker.record
        def run_after_restore(name, value):
            record(name, value)
            if name == 'effect-0-bootstrap-ack.json':
                self.churn(root, 1)
        worker.record = run_after_restore
        self.assertEqual(worker.execute()['kind'], 'committed')
        # Later cycles keep rewriting the ledger and consuming inbox requests.
        self.churn(root, 2)
        self.assertEqual(worker.observe()['kind'], 'committed')

    def test_changed_consumer_config_or_marker_still_refuses_after_restore(self):
        for name in ('https_broker.py', 'host-config.json', 'channel/installed.json'):
            with self.subTest(name):
                self.setUp()  # A fresh committed deployment per case.
                worker, observer, states, effects = self.native(running=True)
                self.assertEqual(worker.execute()['kind'], 'committed')
                path = Path(self.targets[0]['root']) / name
                original = path.read_bytes()
                self.write(path, encode({**json.loads(original), 'changed': True}) if name.endswith('.json') else original + b'\n')
                self.assertEqual(worker.observe()['kind'], 'unresolved')

    def test_missing_final_receipt_confirms_only_complete_evidence(self):
        # The 9491d417 shape: committed and restored, then the old post-restore check
        # refused the rewritten ledger before the final receipt was written.
        worker, observer, states, effects = self.native(running=True)
        root = self.targets[0]['root']
        record = worker.record
        def lose_receipt(name, value):
            if name == 'deployment-commit.json':
                raise ValueError('Existing channel or ledger changed')
            record(name, value)
            if name == 'effect-0-bootstrap-ack.json':
                self.churn(root, 1)
        worker.record = lose_receipt
        with self.assertRaisesRegex(ValueError, 'ledger changed'): worker.execute()
        self.assertFalse((self.evidence / 'deployment-commit.json').exists())
        evidence = {path.name: path.read_bytes() for path in self.evidence.iterdir()}
        self.churn(root, 2)
        self.assertEqual(worker.observe()['kind'], 'committed')
        self.assertEqual({path.name: path.read_bytes() for path in self.evidence.iterdir()}, evidence)
        # Each incomplete or foreign shape stays unresolved.
        commit = json.loads(evidence['commit.json'])
        foreign = lambda name: encode({**json.loads(evidence[name]), 'outerPlanSha256': '0' * 64})
        window = json.loads(evidence['window-verified.json'])
        cases = [('ack-3.json', None), ('intent-5.json', None), ('effect-0-bootstrap-ack.json', None),
                 ('effect-1-enable-ack.json', None), ('admission.json', None),
                 ('effect-0-disable-intent.json', foreign('effect-0-disable-intent.json')),
                 ('effect-1-enable-ack.json', foreign('effect-1-enable-ack.json')),
                 ('before.json', foreign('before.json')),
                 ('window-verified.json', None),
                 ('window-verified.json', encode({**window, 'commitSha256': '0' * 64})),
                 ('window-verified.json', foreign('window-verified.json')),
                 ('admission.json', encode({**json.loads(evidence['admission.json']), 'evidenceVersion': 3})),
                 ('commit.json', encode({**commit, 'planSha256': '0' * 64})),
                 ('commit.json', encode({**commit, 'files': commit['files'][:7]})),
                 ('abort-restored.json', encode({'outerPlanSha256': worker.outer}))]
        for name, replacement in cases:
            path = self.evidence / name
            if replacement is None:
                path.unlink()
            else:
                self.write(path, replacement)
            self.assertEqual(worker.observe()['kind'], 'unresolved', name)
            if name in evidence:
                self.write(path, evidence[name])
            else:
                path.unlink()
        outer, worker.outer = worker.outer, '0' * 64
        self.assertEqual(worker.observe()['kind'], 'unresolved', 'plan digest')
        worker.outer = outer
        consumer = Path(root) / 'host_config.py'
        original = consumer.read_bytes()
        self.write(consumer, b'changed consumer')
        self.assertEqual(worker.observe()['kind'], 'unresolved', 'consumer')
        # Restoring the bytes does not restore the committed file's identity.
        self.write(consumer, original)
        self.assertEqual(worker.observe()['kind'], 'unresolved', 'rewritten consumer')

    def test_legacy_run_without_window_record_confirms_by_explicit_rule(self):
        # Workers before evidence version 2 wrote neither the admission marker nor the
        # window record, like 9491d417. Their commit.json stands for the window check.
        worker, observer, states, effects = self.native(running=True)
        record = worker.record
        def legacy(name, value):
            if name == 'deployment-commit.json':
                raise ValueError('Existing channel or ledger changed')
            if name == 'window-verified.json':
                return
            if name == 'admission.json':
                value = {key: item for key, item in value.items() if key != 'evidenceVersion'}
            record(name, value)
        worker.record = legacy
        with self.assertRaises(ValueError): worker.execute()
        self.assertFalse((self.evidence / 'window-verified.json').exists())
        self.assertEqual(worker.observe()['kind'], 'committed')
        # The legacy rule is keyed on the missing marker, not on a missing window record.
        admission = self.evidence / 'admission.json'
        self.write(admission, encode({**json.loads(admission.read_bytes()), 'evidenceVersion': 2}))
        self.assertEqual(worker.observe()['kind'], 'unresolved')

    def test_receipt_binds_window_evidence(self):
        worker, observer, states, effects = self.native(running=True)
        self.assertEqual(worker.execute()['kind'], 'committed')
        window = self.evidence / 'window-verified.json'
        original = window.read_bytes()
        value = json.loads(original)
        self.assertEqual(value['outerPlanSha256'], worker.outer)
        self.write(window, encode({**value, 'installedFilesSha256': '0' * 64}))
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        self.write(window, original)
        self.assertEqual(worker.observe()['kind'], 'committed')

    def test_broker_serving_requests_after_restore_confirms(self):
        # After restore the broker consumes requests and writes receipts and origins.
        channel = Path(self.targets[0]['root']) / 'channel'
        request = channel / 'inbox' / (str(uuid.uuid4()) + '.json')
        self.write(request, b'queued request')
        worker, observer, states, effects = self.native(running=True)
        record = worker.record
        def serve(name, value):
            record(name, value)
            if name == 'effect-0-bootstrap-ack.json':
                request.unlink()
                self.write(channel / 'receipts' / request.name, b'{"status": "ready"}')
                self.write(channel / 'origins' / 'wks_test.preview.json', b'{"origin": "https://h:32768"}')
                self.churn(self.targets[0]['root'], 1)
        worker.record = serve
        self.assertEqual(worker.execute()['kind'], 'committed')
        self.write(channel / 'origins' / 'wks_test.preview.json', b'{"origin": "https://h:32769"}')
        self.assertEqual(worker.observe()['kind'], 'committed')

    def test_running_mode_refuses_wrong_mode_or_stale_digest_before_effects(self):
        worker, observer, states, effects = self.native(running=True)
        root = Path(self.targets[0]['root'])
        # The owner approved a refusing channel; the live one now serves requests.
        self.plan['registrations'][0]['admission'] = 'refusing'
        with self.assertRaisesRegex(ValueError, 'admission differs from the approved plan'): worker.execute()
        self.plan['registrations'][0]['admission'] = 'running'
        # A full-inventory digest cannot hold for a running broker.
        self.targets[0]['preservationSha256'] = approved_preservation_sha256(preservation(root), 'refusing')
        self.write(root / 'https-broker-ledger.json', encode({'entries': {}, 'requests': {}, 'reconcileCursor': 1}))
        with self.assertRaisesRegex(ValueError, 'Preservation inventory changed; refresh'): worker.execute()
        self.assertEqual(effects, [])
        self.assertFalse((self.evidence / 'admission.json').exists())

    def test_inventory_change_after_baseline_aborts_and_restores_before_write(self):
        worker, observer, states, effects = self.native(running=True)
        root = Path(self.targets[0]['root'])
        record = worker.record
        def arrive_after_baseline(name, value):
            record(name, value)
            if name == 'before.json':
                self.write(root / 'channel' / 'inbox' / (str(uuid.uuid4()) + '.json'), b'late request')
        worker.record = arrive_after_baseline
        with self.assertRaisesRegex(ValueError, 'changed after suppression'): worker.execute()
        self.assertEqual(effects, [(0,'disable'), (0,'bootout'), (1,'disable'), (1,'enable'), (0,'enable'), (0,'bootstrap')])
        self.assertTrue(states[0]['loaded'])
        self.assertTrue((self.evidence / 'abort-restored.json').exists())
        self.assertFalse((self.evidence / 'intent.json').exists())
        self.assertEqual(worker.observe()['kind'], 'unresolved')
        self.assertEqual((root / 'https_broker.py').read_bytes(), self.originals[str(root / 'https_broker.py')])

    def test_generation_surviving_bootout_keeps_suppression(self):
        worker, observer, states, effects = self.native(running=True)
        # Pid 40 keeps running the protected route after its scheduler is booted out.
        observer.kernel.pids = lambda uid: [40]
        observer.kernel.argv = lambda pid: observer.bindings[0]['argv']
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): worker.execute()
        self.assertEqual(effects, [(0,'disable'), (0,'bootout'), (1,'disable')])
        self.assertFalse(states[0]['loaded'])
        self.assertTrue((self.evidence / 'abort-not-restored.json').exists())
        self.assertFalse((self.evidence / 'abort-restored.json').exists())

    def test_generation_appearing_during_window_recheck_keeps_suppression(self):
        worker, observer, states, effects = self.native(running=True)
        record = worker.record
        def appear_after_baseline(name, value):
            record(name, value)
            if name == 'before.json':
                # An untracked route generation appears after suppression settled.
                observer.kernel.pids = lambda uid: [40]
                observer.kernel.argv = lambda pid: observer.bindings[0]['argv']
        worker.record = appear_after_baseline
        with self.assertRaisesRegex(ValueError, 'Unlisted broker caller'): worker.execute()
        self.assertEqual(effects, [(0,'disable'), (0,'bootout'), (1,'disable')])
        self.assertTrue((self.evidence / 'abort-not-restored.json').exists())
        self.assertFalse((self.evidence / 'abort-restored.json').exists())
        self.assertFalse((self.evidence / 'intent.json').exists())

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

    def test_plist_swapped_after_enable_refuses_before_bootstrap(self):
        import plistlib
        worker, observer, states, effects = self.native()
        plist = Path(observer.bindings[0]['plist']['path'])
        record = worker.record
        # Swap once enable's readback has passed, before launchd loads the plist.
        def swap_after_enable(name, value):
            record(name, value)
            if name == 'effect-0-enable-ack.json':
                self.write(plist, plistlib.dumps({'Label': 'local.test.broker0', 'ProgramArguments': ['/tmp/agent']}))
        worker.record = swap_after_enable
        with self.assertRaisesRegex(ValueError, 'Broker plist changed'): worker.execute()
        self.assertNotIn((0, 'bootstrap'), effects)

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



class BrokerCadenceTests(unittest.TestCase):
    def test_installers_run_the_broker_at_the_interval_its_attribution_window_assumes(self):
        from https_broker import BROKER_INTERVAL_SECONDS
        here = Path(__file__).resolve().parent
        for installer in ('install-https-broker.py', 'install-native-https-broker.py'):
            intervals = re.findall(r"'StartInterval': (\d+)", (here / installer).read_text(encoding='utf-8'))
            self.assertEqual([int(value) for value in intervals], [BROKER_INTERVAL_SECONDS], installer)

    def test_unreadable_source_yields_no_publishable_messages(self):
        import https_broker
        self.assertEqual(https_broker._broker_messages(Path(__file__).parent / 'missing-source.py'), frozenset())
        self.assertIn('Managed service stopped; explicit start required', https_broker.BROKER_MESSAGES)
        self.assertEqual(https_broker.public_error("invalid literal for int() with base 10: '/x'"), 'Error')


if __name__ == '__main__':
    unittest.main()
