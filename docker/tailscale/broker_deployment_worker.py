"""Fixed native consumer deployment operation, loaded only by the coordinator."""
import json
import os
from pathlib import Path
import socket
import sys
import time
from channel_identity import physical_directory, read_file, file_identity
from broker_deployment import (deploy_files, exclusive, encode, sha, preservation, assert_preserved, directory_pin,
                               approved_preservation_sha256)
from broker_deployment_observation import NativeObservation


class ParentGuard:
    def __init__(self, session):
        self.session = session
        self.sequence = 0
        self.socket = socket.socket(fileno=3)
        self.socket.settimeout(10)
        self.stream = self.socket.makefile('rwb', buffering=0)

    def __call__(self):
        self.sequence += 1
        message = {'session': self.session, 'sequence': self.sequence, 'operation': 'guard'}
        self.stream.write(encode(message))
        raw = self.stream.readline(4097)
        if not raw or len(raw) > 4096:
            raise ValueError('Parent custody channel closed or oversized')
        if json.loads(raw) != {**message, 'admitted': True}:
            raise ValueError('Parent queue or protected custody refused')


# Transient states while a scheduler generation finishes; every other refusal is final.
SETTLING = ('Unlisted broker caller or waiting generation remains', 'Old registered consumer remains active')


def settle(check, seconds=15, sleep=time.sleep):
    """Repeat a read-only check while only a finishing broker generation fails it."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            return check()
        except ValueError as error:
            if str(error) not in SETTLING or time.monotonic() >= deadline:
                raise
        sleep(0.25)


class Deployment:
    # Bound for a finishing scheduler generation to exit; tests shorten it.
    settle_seconds = 15

    def __init__(self, packet, guard, observer=None):
        self.packet = packet
        self.plan = packet['plan']
        self.guard = guard
        self.root = Path(self.plan['evidenceDirectory'])
        self.outer = packet['planSha256']
        self.check_evidence()
        self.observer = observer or NativeObservation(self.plan, packet['bindings'], guard)
        self.inner = {key: self.plan[key] for key in ('version', 'operation', 'id', 'evidenceDirectory', 'targets')}
        # Native effects whose acknowledgement is not yet recorded. Any entry makes an
        # abort uncertain, so original registrations are then never restored.
        self.unacknowledged = set()
        self.suppressed = []
        self.replacing = False
        self.unsettled = False
        self.baseline = None

    def check_evidence(self):
        with physical_directory(self.root) as (info, check):
            if directory_pin(info) != self.plan['evidenceDirectoryIdentity'] or info.st_uid != os.getuid() or (info.st_mode & 0o777) != 0o700:
                raise ValueError('Prepared evidence directory identity changed')
            check()

    def read(self, name):
        self.check_evidence()
        raw, _ = read_file(self.root / name, protected=True)
        return json.loads(raw), sha(raw)

    def record(self, name, value):
        self.check_evidence()
        self.guard()
        with physical_directory(self.root) as (_, check):
            exclusive(check.directory_fd, name, encode(value))
            check()
        self.guard()

    def command(self, index, action, binding):
        target = binding['domain'] + '/' + binding['label']
        if action in ('disable', 'enable', 'bootout'):
            args = ['/bin/launchctl', action, target]
        elif action == 'bootstrap':
            args = ['/bin/launchctl', action, binding['domain'], binding['plist']['path']]
        else:
            raise ValueError('Unsupported broker effect')
        if action in ('disable', 'bootout'):
            state = self.observer.state(binding)
            expected = self.plan['registrations'][index]
            # A running broker's scheduler may start a new protected-route generation at
            # any time; state() already refused any other process for the label.
            running = self.observer.admission[index] == 'running' and expected['process'] is None
            if state['process'] is not None and state['process'] != expected['process'] and not running:
                raise ValueError('Broker process changed before scheduler effect')
        else:
            # Re-read the plist immediately before launchd uses it: its digest, Label and
            # ProgramArguments must still equal the protected binding (observer.state raises).
            self.observer.state(binding)
        self.record(f'effect-{index}-{action}-intent.json', {'outerPlanSha256': self.outer, 'argv': args})
        self.guard()
        self.unacknowledged.add((index, action))
        result = self.observer.invoke(args)
        # A lost/failed response is uncertain. Never repeat it or restore in finally.
        if result.returncode or result.stderr.strip():
            raise ValueError('Native broker effect unresolved; inspect retained intent')
        state = self.observer.state(binding)
        if ((action == 'disable' and state['enabled']) or
                (action == 'enable' and not state['enabled']) or
                (action == 'bootout' and state['disposition'] != 'absent') or
                (action == 'bootstrap' and state['disposition'] != 'loaded')):
            raise ValueError('Native broker effect readback differs')
        self.record(f'effect-{index}-{action}-ack.json', {'outerPlanSha256': self.outer, 'state': state})
        self.unacknowledged.discard((index, action))

    def mode(self, root):
        return self.observer.admission[[binding['root'] for binding in self.packet['bindings']].index(root)]

    def preservation_sha256(self, root, state):
        return approved_preservation_sha256(state, self.mode(root))

    def locked_preservation_sha256(self, root, state):
        # A running-mode plan approves only config and marker, so under the locks the
        # full inventory must still equal the post-suppression baseline exactly.
        if self.mode(root) == 'running' and encode(state) != encode(self.baseline[root]):
            raise ValueError('Preservation inventory changed after suppression')
        return self.preservation_sha256(root, state)

    def verify_files(self):
        commit, digest = self.read('commit.json')
        if commit['planSha256'] != sha(encode(self.inner)):
            raise ValueError('File commitment belongs to another plan')
        expected = {(item['root'], name): data for item in self.plan['targets'] for name, data in item['files'].items()}
        if len(commit['files']) != 8 or len({(item['root'], item['name']) for item in commit['files']}) != 8:
            raise ValueError('Incomplete file commitment')
        for item in commit['files']:
            desired = expected[(item['root'], item['name'])]
            raw, info = read_file(Path(item['root']) / item['name'], protected=True)
            # Compare native integer identities in Python, never round-trip via JS.
            if sha(raw) != desired['candidate']['sha256'] or sha(raw) != item['sha256'] or list(file_identity(info)) != item['identity']:
                raise ValueError('Committed consumer changed')
        before, _ = self.read('before.json')
        if (before['innerPlanSha256'] != sha(encode(self.inner)) or
                before['outerPlanSha256'] != self.outer or
                set(before['preservation']) != {target['root'] for target in self.plan['targets']}):
            raise ValueError('Retained preservation baseline belongs to another plan')
        for target in self.plan['targets']:
            if self.preservation_sha256(target['root'], before['preservation'][target['root']]) != target['preservationSha256']:
                raise ValueError('Retained preservation baseline differs from approved digest')
        additions = {}
        after = {}
        for target in self.plan['targets']:
            root = target['root']
            after[root] = json.loads(encode(preservation(Path(root))))
            additions[root] = assert_preserved(before['preservation'][root], after[root])
        return digest, sha(encode(commit['files'])), {'baseline': before['preservation'], 'after': after, 'inboxAdditions': additions}

    def restored_states(self):
        states = []
        self.observer.assert_manual_exited()
        for expected, binding in zip(self.plan['registrations'], self.packet['bindings']):
            self.observer.assert_admission(binding)
            state = self.observer.state(binding)
            if state['enabled'] != expected['enabled'] or state['disposition'] != expected['disposition']:
                raise ValueError('Prior broker registration behavior not restored')
            if not self.observer.old_process_exited(expected['process']):
                raise ValueError('Old broker process still present')
            states.append(state)
        self.observer.assert_no_unlisted([state["process"] for state in states])
        return states

    def execute(self):
        before = settle(self.observer.validate, self.settle_seconds)
        self.record('admission.json', {'outerPlanSha256': self.outer, 'admission': self.observer.admission,
                                       'registrations': before})
        for index, binding in enumerate(self.packet['bindings']):
            raw, _ = read_file(binding['plist']['path'], protected=True)
            self.guard()
            with physical_directory(self.root) as (_, check):
                exclusive(check.directory_fd, f'original-plist-{index}', raw)
                check()
        try:
            # Suppress the complete pair before any file replacement.
            for index, (expected, binding) in enumerate(zip(self.plan['registrations'], self.packet['bindings'])):
                if expected['enabled']:
                    self.command(index, 'disable', binding)
                    self.suppressed.append((index, 'disable'))
                if expected['disposition'] == 'loaded':
                    self.command(index, 'bootout', binding)
                    self.suppressed.append((index, 'bootout'))
            try:
                settle(self.observer.assert_suppressed, self.settle_seconds)
            except ValueError as error:
                # A generation outlived its scheduler: launchd no longer accounts for it.
                self.unsettled = str(error) in SETTLING
                raise
            # The baseline is taken only now: a running broker rewrites its ledger
            # until its scheduler is suppressed and its last generation has exited.
            self.baseline = {t['root']: preservation(Path(t['root'])) for t in self.plan['targets']}
            self.record('before.json', {'outerPlanSha256': self.outer, 'innerPlanSha256': sha(encode(self.inner)),
                                      'registrations': before, 'preservation': self.baseline})
            deploy_files(self.inner, [item['root'] for item in self.packet['bindings']],
                         verify_window=self.observer.assert_suppressed, checkpoint=self.checkpoint,
                         preservation_sha256=self.locked_preservation_sha256)
        except BaseException as error:
            self.restore_after_abort(error)
            raise
        self.verify_files()
        self.observer.assert_suppressed()
        for index, (expected, binding) in enumerate(zip(self.plan['registrations'], self.packet['bindings'])):
            self.observer.assert_admission(binding)
            if expected['enabled']:
                self.command(index, 'enable', binding)
            if expected['disposition'] == 'loaded':
                self.command(index, 'bootstrap', binding)
        states = self.restored_states()
        commit, files, preservation_report = self.verify_files()
        self.record('deployment-commit.json', {'outerPlanSha256': self.outer, 'commitSha256': commit,
                    'installedFilesSha256': files, 'preservationSha256': sha(encode(preservation_report)),
                    'preservationReport': preservation_report,
                    'registrationsSha256': sha(encode(states)), 'states': states})
        return self.observe()

    def checkpoint(self, stage, index):
        if stage == 'before-write':
            self.replacing = True

    def restore_after_abort(self, error):
        """Return the original brokers to service when no consumer file was replaced.

        Only certain states qualify: every suppression effect acknowledged, no
        surviving broker generation and no replacement write begun. A lost or
        unresolved native response, a generation that outlived bootout, or any abort
        after the first write keeps the suppression and its evidence for recovery.
        The job still ends without a commitment and is never replayed.
        """
        if self.replacing or self.unacknowledged or not self.suppressed:
            return
        if self.unsettled or str(error) in SETTLING:
            # Starting new generations beside one launchd no longer tracks would hide
            # an unexplained process from recovery, so this abort keeps suppression.
            # This also covers the same refusal from a later window recheck.
            self.note('abort-not-restored.json', {'reason': 'broker generation survived suppression',
                                                  'error': str(error)[:512]})
            return
        try:
            # Per broker, enable before bootstrap: launchd refuses to load a disabled job.
            for index in sorted({index for index, _ in self.suppressed}, reverse=True):
                for undo, action in (('enable', 'disable'), ('bootstrap', 'bootout')):
                    if (index, action) in self.suppressed:
                        self.command(index, undo, self.packet['bindings'][index])
        except Exception as restore_error:
            self.note('abort-restore-failed.json', {'error': str(error)[:512], 'restoreError': str(restore_error)[:512]})
            return
        self.note('abort-restored.json', {'restored': self.suppressed, 'error': str(error)[:512]})

    def note(self, name, value):
        """Best-effort abort evidence; the original error is always what propagates."""
        try:
            self.record(name, {'outerPlanSha256': self.outer, **value})
        except Exception:
            pass

    def observe(self):
        unresolved = {'kind': 'unresolved', 'id': self.plan['id'], 'planSha256': self.outer,
                      'reason': 'evidence-unconfirmed'}
        try:
            receipt, _ = self.read('deployment-commit.json')
            before, _ = self.read('before.json')
            if self.observer.admission is None:
                self.observer.admission = self.recorded_admission()
            if before['outerPlanSha256'] != self.outer or receipt['outerPlanSha256'] != self.outer:
                return unresolved
            commit, files, current_preservation = self.verify_files()
            self.restored_states()
            historical = receipt['preservationReport']
            if (receipt['preservationSha256'] != sha(encode(historical)) or
                    historical['baseline'] != before['preservation'] or
                    set(historical) != {'baseline', 'after', 'inboxAdditions'}):
                return unresolved
            if set(historical['inboxAdditions']) != set(current_preservation['inboxAdditions']):
                return unresolved
            for root, names in historical['inboxAdditions'].items():
                if not isinstance(names, list) or names != sorted(set(names)) or any(not name.startswith('inbox/') for name in names):
                    return unresolved
                if assert_preserved(historical['baseline'][root], historical['after'][root]) != names:
                    return unresolved
                assert_preserved(historical['after'][root], current_preservation['after'][root])
            retained_states = receipt['states']
            if len(retained_states) != 2 or receipt['registrationsSha256'] != sha(encode(retained_states)):
                return unresolved
            for state, expected, binding in zip(retained_states, self.plan['registrations'], self.packet['bindings']):
                if (state['enabled'] != expected['enabled'] or state['disposition'] != expected['disposition'] or
                        state['plistSha256'] != binding['plist']['sha256']):
                    return unresolved
                process = state['process']
                if process is not None and (process['argv'] != binding['argv'] or process['uid'] != os.getuid()):
                    return unresolved
            if receipt['commitSha256'] != commit or receipt['installedFilesSha256'] != files:
                return unresolved
            self.guard()
            return {'kind': 'committed', 'id': self.plan['id'], 'planSha256': self.outer,
                    **{key: receipt[key] for key in ('commitSha256', 'installedFilesSha256', 'preservationSha256', 'registrationsSha256')}}
        except (OSError, ValueError, KeyError, TypeError):
            return unresolved


    def recorded_admission(self):
        """Admission from evidence. Attempts made before running admission existed
        recorded none and could only have admitted refusing channels."""
        if not (self.root / 'admission.json').exists():
            return ['refusing'] * len(self.packet['bindings'])
        admission, _ = self.read('admission.json')
        if admission['outerPlanSha256'] != self.outer:
            raise ValueError('Recorded admission belongs to another plan')
        return admission['admission']


def coordinator_main():
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Oversized deployment packet')
    packet = json.loads(raw)
    guard = ParentGuard(packet['session'])
    guard()
    operation = Deployment(packet, guard)
    if packet['operation'] == 'inspect':
        for name in ('child-intent.json', 'admission.json', 'before.json', 'intent.json', 'deployment-commit.json'):
            if (operation.root / name).exists() or (operation.root / name).is_symlink():
                raise ValueError('Deployment evidence already contains an attempt; reconcile without replay')
        settle(operation.observer.validate, operation.settle_seconds)
        result = {'prepared': True, 'admission': operation.observer.admission}
    elif packet['operation'] == 'execute':
        result = operation.execute()
    elif packet['operation'] == 'observe':
        result = operation.observe()
    else:
        raise ValueError('Unknown deployment operation')
    guard()
    print(json.dumps(result, separators=(',', ':'), allow_nan=False))
