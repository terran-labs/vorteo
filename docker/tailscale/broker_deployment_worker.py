"""Fixed native consumer deployment operation, loaded only by the coordinator."""
import json
import os
from pathlib import Path
import socket
import sys
import time
from channel_identity import physical_directory, read_file, file_identity
from broker_deployment import deploy_files, exclusive, encode, sha, preservation, assert_preserved, directory_pin
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


class Deployment:
    def __init__(self, packet, guard, observer=None):
        self.packet = packet
        self.plan = packet['plan']
        self.guard = guard
        self.root = Path(self.plan['evidenceDirectory'])
        self.outer = packet['planSha256']
        self.check_evidence()
        self.observer = observer or NativeObservation(self.plan, packet['bindings'], guard)
        self.inner = {key: self.plan[key] for key in ('version', 'operation', 'id', 'evidenceDirectory', 'targets')}

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
            if state['process'] is not None and state['process'] != expected['process']:
                raise ValueError('Broker process changed before scheduler effect')
        else:
            # Re-read the plist immediately before launchd uses it: its digest, Label and
            # ProgramArguments must still equal the protected binding (observer.state raises).
            self.observer.state(binding)
        self.record(f'effect-{index}-{action}-intent.json', {'outerPlanSha256': self.outer, 'argv': args})
        self.guard()
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
            if sha(encode(before['preservation'][target['root']])) != target['preservationSha256']:
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
            self.observer.assert_refusing_channel(binding)
            state = self.observer.state(binding)
            if state['enabled'] != expected['enabled'] or state['disposition'] != expected['disposition']:
                raise ValueError('Prior broker registration behavior not restored')
            if not self.observer.old_process_exited(expected['process']):
                raise ValueError('Old broker process still present')
            states.append(state)
        self.observer.assert_no_unlisted([state["process"] for state in states])
        return states

    def execute(self):
        before = self.observer.validate()
        for index, binding in enumerate(self.packet['bindings']):
            raw, _ = read_file(binding['plist']['path'], protected=True)
            self.guard()
            with physical_directory(self.root) as (_, check):
                exclusive(check.directory_fd, f'original-plist-{index}', raw)
                check()
        self.record('before.json', {'outerPlanSha256': self.outer, 'innerPlanSha256': sha(encode(self.inner)),
                                  'registrations': before,
                                  'preservation': {t['root']: preservation(Path(t['root'])) for t in self.plan['targets']}})
        # Suppress the complete pair before any file replacement.
        for index, (expected, binding) in enumerate(zip(self.plan['registrations'], self.packet['bindings'])):
            if expected['enabled']:
                self.command(index, 'disable', binding)
            if expected['disposition'] == 'loaded':
                self.command(index, 'bootout', binding)
        self.observer.assert_suppressed()
        deploy_files(self.inner, [item['root'] for item in self.packet['bindings']],
                     verify_window=self.observer.assert_suppressed)
        self.verify_files()
        self.observer.assert_suppressed()
        for index, (expected, binding) in enumerate(zip(self.plan['registrations'], self.packet['bindings'])):
            self.observer.assert_refusing_channel(binding)
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

    def observe(self):
        unresolved = {'kind': 'unresolved', 'id': self.plan['id'], 'planSha256': self.outer,
                      'reason': 'evidence-unconfirmed'}
        try:
            receipt, _ = self.read('deployment-commit.json')
            before, _ = self.read('before.json')
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


def coordinator_main():
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Oversized deployment packet')
    packet = json.loads(raw)
    guard = ParentGuard(packet['session'])
    guard()
    operation = Deployment(packet, guard)
    if packet['operation'] == 'inspect':
        for name in ('child-intent.json', 'before.json', 'intent.json', 'deployment-commit.json'):
            if (operation.root / name).exists() or (operation.root / name).is_symlink():
                raise ValueError('Deployment evidence already contains an attempt; reconcile without replay')
        operation.observer.validate()
        result = {'prepared': True}
    elif packet['operation'] == 'execute':
        result = operation.execute()
    elif packet['operation'] == 'observe':
        result = operation.observe()
    else:
        raise ValueError('Unknown deployment operation')
    guard()
    print(json.dumps(result, separators=(',', ':'), allow_nan=False))
