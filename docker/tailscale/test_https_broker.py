import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
from https_broker import Broker, Runtime, NativeRuntime, atomic, safe_read, validate


class NativeWorkspacePolicyTests(unittest.TestCase):
    def test_retained_tailnet_connection_does_not_block_owned_restart(self):
        runtime = NativeRuntime({'nodeId': 'node', 'hostname': 'test.ts.net'})
        runtime.ts = lambda args: json.dumps({'Self': {'ID': 'node', 'DNSName': 'test.ts.net.', 'TailscaleIPs': ['100.64.0.1']}})
        row = 'tcp4 0 0 100.64.0.1.32768 100.64.0.2.50000 ESTABLISHED'
        runtime.command = lambda args: row
        with patch('https_broker.socket.socket') as socket:
            socket.return_value.__enter__.return_value.bind.side_effect = OSError('occupied')
            with self.assertRaises(subprocess.SubprocessError):
                runtime.free(32768)
            runtime.free(32768, retained=True)
            for blocked in ('tcp4 0 0 *.32768 *.* LISTEN',
                            'tcp4 0 0 127.0.0.1.32768 127.0.0.1.50000 ESTABLISHED'):
                row = blocked
                with self.assertRaises(subprocess.SubprocessError):
                    runtime.free(32768, retained=True)
            row = 'tcp4 0 0 100.64.0.1.32768 100.64.0.2.50000 ESTABLISHED\ntcp4 0 0 *.32768 *.* LISTEN'
            with self.assertRaises(subprocess.SubprocessError):
                runtime.free(32768, retained=True)

    def test_dedicated_previews_node_is_addressed_by_socket(self):
        calls = []
        for config, expected in (
            ({'tailscale': '/bin/ts'}, ['/bin/ts', 'status']),
            ({'tailscale': '/bin/ts', 'tailscaleSocket': '/run/previews.sock'},
             ['/bin/ts', '--socket=/run/previews.sock', 'status']),
        ):
            runtime = NativeRuntime(config)
            runtime.command = lambda args: calls.append(args) or ''
            runtime.ts(['status'])
            self.assertEqual(calls[-1], expected)

    def test_previews_node_runs_in_userspace_with_its_own_state(self):
        spec = importlib.util.spec_from_file_location('previews_node', Path(__file__).with_name('install-previews-node.py'))
        node = importlib.util.module_from_spec(spec); spec.loader.exec_module(node)
        planned = node.plan('/srv/previews-node', '/opt/bin/tailscaled', 'vorton-previews')
        self.assertEqual(planned['content']['ProgramArguments'],
                         ['/opt/bin/tailscaled', '--tun=userspace-networking', '--statedir=/srv/previews-node/state',
                          '--socket=/srv/previews-node/tailscaled.sock', '--port=0'])
        for name in ('Bad_Name', '-lead', 'a.b', ''):
            with self.assertRaises(ValueError):
                node.plan('/srv/previews-node', '/opt/bin/tailscaled', name)
        with self.assertRaises(ValueError):
            node.plan('relative/dir', '/opt/bin/tailscaled', 'previews')
        with tempfile.TemporaryDirectory() as directory:
            node.private_directory(directory)
            os.chmod(directory, 0o755)
            with self.assertRaises(ValueError):
                node.private_directory(directory)
            link = Path(directory) / 'link'; link.symlink_to(directory)
            with self.assertRaises(ValueError):
                node.private_directory(link)
            # A shim that links to the binary names the same login agent as its target,
            # at install and at removal, including after the binary is gone.
            target = Path(os.path.realpath(directory)) / 'tailscaled'; target.write_text('')
            shim = Path(directory) / 'shim'; shim.symlink_to(target)
            self.assertEqual(node.canonical(shim), target)
            installed = node.plan('/srv/previews-node', node.canonical(shim), 'previews')
            removing = node.plan('/srv/previews-node', node.canonical(shim), 'previews')
            self.assertEqual(installed['content']['ProgramArguments'][0], str(target))
            self.assertEqual(installed['label'], removing['label'])
            target.unlink()
            self.assertEqual(node.canonical(target), target)

    def test_broker_moves_node_only_when_nothing_is_published(self):
        spec = importlib.util.spec_from_file_location('native_installer', Path(__file__).with_name('install-native-https-broker.py'))
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        base = {'runtime': 'native', 'daemonHome': '/home', 'cliCommand': ['/node', '/cli'], 'channel': '/channel',
                'workspacePolicy': 'registered', 'allowedRoots': []}
        old = {**base, 'tailscale': '/app/ts', 'nodeId': 'old', 'hostname': 'mac.ts.net', 'packetFilterHash': 'a'}
        new = {**base, 'tailscale': '/bin/ts', 'tailscaleSocket': '/run/previews.sock', 'nodeId': 'new',
               'hostname': 'previews.ts.net', 'packetFilterHash': 'b'}
        stopped = {'entries': {'w.s': {'frontend': 32770, 'desired': 'stopped'}}}
        running = {'entries': {'w.s': {'frontend': 32770, 'desired': 'running'}}}
        nothing = lambda: {}
        # Unchanged identity and a first install need no flag.
        installer.check_identity(old, dict(old), running, False, nothing)
        installer.check_identity({}, new, {}, False, nothing)
        # A different node is refused without the explicit move, while a preview runs, and
        # while the old node still publishes a port the ledger owns.
        for ledger, move, publication in ((stopped, False, nothing), (running, True, nothing),
                                          (stopped, True, lambda: {'TCP': {'32770': {'HTTPS': True}}})):
            with self.assertRaises(ValueError):
                installer.check_identity(old, new, ledger, move, publication)
        installer.check_identity(old, new, stopped, True, lambda: {'TCP': {'443': {'HTTPS': True}}})
        # The switch happens under the broker's lock, on what is on disk at that moment.
        # A start the old broker consumed after any earlier look is seen and refused,
        # and nothing is replaced or re-pinned.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(os.path.realpath(directory)) / 'broker'; channel = root / 'channel'
            (channel / 'origins').mkdir(parents=True); root.chmod(0o700)
            origin = channel / 'origins' / 'w.s.json'; origin.write_text('{}')
            atomic(root / 'host-config.json', old)
            atomic(root / 'https-broker-ledger.json', running)
            replaced = []
            class OldNode:
                def __init__(self, config): self.config = config
                def preflight(self): replaced.append('preflight')
                def publication(self): return {}
            with self.assertRaises(ValueError):
                installer.switch_pins(root, channel, new, True, lambda: replaced.append('files'), OldNode)
            self.assertEqual(safe_read(root / 'host-config.json'), old)
            self.assertNotIn('files', replaced)
            self.assertTrue(origin.exists())
            # While a broker run holds the lock the installer waits, then gives up cleanly.
            with installer.broker_lock(root):
                with self.assertRaises(ValueError):
                    installer.switch_pins(root, channel, new, True, lambda: None, OldNode, wait=0.2)
            # With everything stopped the old node is verified, files and pins switch, and
            # reservations that name the old hostname are dropped.
            atomic(root / 'https-broker-ledger.json', stopped)
            installer.switch_pins(root, channel, new, True, lambda: replaced.append('files'), OldNode)
            self.assertEqual(safe_read(root / 'host-config.json'), new)
            self.assertEqual(replaced[-2:], ['preflight', 'files'])
            self.assertFalse(origin.exists())
            # A socket is accepted only when this user owns it inside a private directory.
            import socket as sockets
            private = root / 'node'; private.mkdir(mode=0o700)
            listener = sockets.socket(sockets.AF_UNIX); listener.bind(str(private / 'd.sock'))
            try:
                installer.private_socket(private / 'd.sock')
                private.chmod(0o755)
                with self.assertRaises(ValueError):
                    installer.private_socket(private / 'd.sock')
                with self.assertRaises(ValueError):
                    installer.private_socket(root / 'host-config.json')
            finally:
                listener.close()
        # An existing broker directory that others can write is refused, never adopted.
        with tempfile.TemporaryDirectory() as directory:
            fresh = installer.prepare_deployment(Path(os.path.realpath(directory)) / 'new')
            self.assertEqual(os.lstat(fresh).st_mode & 0o777, 0o700)
            open_root = Path(os.path.realpath(directory)) / 'open'; open_root.mkdir(); open_root.chmod(0o777)
            with self.assertRaises(ValueError):
                installer.prepare_deployment(open_root)
        # The move never excuses a change to anything else the broker is pinned to.
        with self.assertRaises(ValueError):
            installer.check_identity(old, {**new, 'daemonHome': '/elsewhere'}, stopped, True, nothing)

    def test_native_listener_rejects_wildcard_and_other_terminal(self):
        runtime = NativeRuntime({})
        runtime.command = lambda args: 'p123\nn*:40001\n'
        with self.assertRaisesRegex(ValueError, 'loopback listener'):
            runtime.listener_pid(40001)
        runtime.command = lambda args: 'p123\nn127.0.0.1:40001\n' if args[0].endswith('lsof') else 'node PASEO_TERMINAL_ID=another'
        runtime.process_identity = lambda pid: {'pid': pid, 'parent': 1, 'birth': '1:2'}
        runtime.terminal_environment = lambda pid: 'another'
        with self.assertRaisesRegex(ValueError, 'managed terminal'):
            runtime.listener_identity(40001, 'terminal_expected')

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS process ownership probe')
    def test_real_native_listener_identity(self):
        # Disposable HTTP fixture only; never start or stop an installed daemon.
        runtime = NativeRuntime({})
        code = 'import socket,time; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(30)'
        process = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True,
                                   env={**os.environ, 'PASEO_TERMINAL_ID': 'terminal_fixture'})
        try:
            port = int(process.stdout.readline())
            identity = runtime.listener_identity(port, 'terminal_fixture')
            self.assertTrue(identity.startswith(str(process.pid) + ':'))
            self.assertEqual(runtime.listener_identity(port, 'terminal_fixture'), identity)
            with self.assertRaisesRegex(ValueError, 'managed terminal'):
                runtime.listener_identity(port, 'terminal_other')
        finally:
            process.terminate()
            process.wait(timeout=5)
            process.stdout.close()

    def test_registered_native_workspace_uses_real_host_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / 'paseo.json').write_text(json.dumps({'scripts': {
                'preview': {'type': 'service', 'command': 'npm run dev', 'port': 40001}}}))
            runtime = NativeRuntime({'workspacePolicy': 'registered'})
            workspace = {'workspaceId': 'wks_native', 'cwd': str(root), 'isolation': 'local'}
            runtime.cli = lambda args: [workspace] if args == ['workspace', 'ls'] else [
                {'scriptName': 'preview', 'type': 'service'}]
            self.assertEqual(runtime.current('wks_native', 'preview')['cwd'], str(root))
            self.assertEqual(runtime.registered_ports(), {40001})
            workspace['archivedAt'] = '2026-10-11'
            with self.assertRaisesRegex(ValueError, 'archived'):
                runtime.current('wks_native', 'preview')
            del workspace['archivedAt']
            alias = root / 'alias'
            alias.symlink_to(root, target_is_directory=True)
            workspace['cwd'] = str(alias)
            with self.assertRaises(OSError):
                runtime.current('wks_native', 'preview')
            # A stale symlinked registration must not block other reservations.
            served = {'workspaceId': 'wks_served', 'cwd': str(root), 'isolation': 'local'}
            runtime.cli = lambda args: [workspace, served] if args == ['workspace', 'ls'] else [
                {'scriptName': 'preview', 'type': 'service'}]
            self.assertEqual(runtime.registered_ports(), {40001})


class DaemonIdentityTests(unittest.TestCase):
    def test_managed_and_legacy_process_identity(self):
        # Execute the broker's Linux probe against isolated procfs fixtures on any host.
        result = subprocess.run(
            ['node', '--test', str(Path(__file__).with_name('https-broker-identity.test.cjs'))],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class WorkspacePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.cwd = '/home/paseo/.paseo/worktrees/project/site'
        self.path = self.root / 'data/home/.paseo/worktrees/project/site'
        self.path.mkdir(parents=True)
        (self.path / 'paseo.json').write_text(json.dumps({'scripts': {'preview': {'type': 'service', 'command': 'npm run dev'}}}))
        self.config = {'docker': '/docker', 'context': 'test', 'deployment': str(self.root),
                       'allowedRoots': [self.cwd], 'approvedWorkspaces': {'wks_site': self.cwd}}
        self.workspaces = [{'workspaceId': 'wks_site', 'cwd': self.cwd, 'isolation': 'worktree'}]
        self.runtime = Runtime(self.config)
        # CLI data is the boundary; policy and safe file reads use real directories.
        self.runtime.cli = lambda args: self.workspaces if args == ['workspace', 'ls'] else [{'scriptName': 'preview', 'type': 'service'}]

    def test_approved_active_worktree(self):
        self.assertEqual(self.runtime.current('wks_site', 'preview')['cwd'], self.cwd)

    def mounted_alias(self):
        self.alias = str(self.path)
        self.config.update(container='dev', hostPathMappings={'/shared': str(self.path.parent)})
        self.config['allowedRoots'] = ['/shared']
        self.config['approvedWorkspaces'] = {'wks_site': '/shared/site'}
        self.workspaces[0]['cwd'] = self.alias
        self.mounts = [{'Type': 'bind', 'Source': str(self.path.parent), 'Destination': '/shared'}]
        self.resolved = '/shared/site'
        self.probes = []

        def docker(args):
            self.probes.append(args)
            if args == ['inspect', '--format', '{{json .Mounts}}', 'dev']:
                return json.dumps(self.mounts)
            self.assertEqual(args, ['exec', '--user', 'paseo', 'dev', '/usr/bin/readlink', '-e', '--', self.alias])
            return self.resolved + '\n'
        self.runtime.docker = docker

    def test_proven_mounted_alias_preserves_retained_workspace_identity(self):
        self.mounted_alias()
        current = self.runtime.current('wks_site', 'preview')
        self.assertEqual(current['cwd'], self.config['approvedWorkspaces']['wks_site'])
        self.assertEqual(self.workspaces[0]['cwd'], self.alias)
        self.assertEqual(len(self.probes), 4)

    def test_unproven_mounted_alias_rejected(self):
        self.mounted_alias()
        for resolved in ('/outside/site', '/shared/other', self.alias):
            with self.subTest(resolved=resolved):
                self.resolved = resolved
                with self.assertRaisesRegex(ValueError, 'does not resolve'):
                    self.runtime.current('wks_site', 'preview')
        self.resolved = '/shared/site'
        self.config['hostPathMappings']['/other'] = str(self.path.parent)
        with self.assertRaisesRegex(ValueError, 'unambiguous'):
            self.runtime.current('wks_site', 'preview')

    def test_changed_alias_mount_destination_rejected(self):
        self.mounted_alias()
        original = self.mounts[0]
        cases = [
            [dict(original, Destination='/moved')],
            [dict(original, Source='/different')],
            [dict(original, Type='volume')],
            [original, dict(original, Destination='/shared/site')],
        ]
        for mounts in cases:
            with self.subTest(mounts=mounts):
                self.mounts = mounts
                with self.assertRaisesRegex(ValueError, 'bind differs|shadowed'):
                    self.runtime.current('wks_site', 'preview')
        self.mounts = [original]
        original_cli = self.runtime.cli

        def cli(args):
            if args[0] == 'script':
                self.mounts = [dict(original, Destination='/moved')]
            return original_cli(args)
        self.runtime.cli = cli
        with self.assertRaisesRegex(ValueError, 'bind differs'):
            self.runtime.current('wks_site', 'preview')

    def test_unrelated_workspace_unaffected_by_alias(self):
        self.mounted_alias()
        self.workspaces.append({'workspaceId': 'wks_other', 'cwd': '/shared/site', 'isolation': 'local'})
        self.assertEqual(self.runtime.current('wks_other', 'preview')['cwd'], '/shared/site')
        self.assertEqual(self.probes, [])
        (self.path / 'paseo.local.json').write_text(json.dumps({'scripts': {'preview': {'port': 40001}}}))
        self.resolved = '/outside/site'
        self.assertEqual(self.runtime.registered_ports(), {40001})
        self.workspaces[1]['cwd'] = '/unmapped/site'
        with self.assertRaisesRegex(ValueError, 'outside administrator policy'):
            self.runtime.current('wks_other', 'preview')

    def test_registered_policy_admits_future_workspaces_without_grants(self):
        self.config.update(workspacePolicy='registered', allowedRoots=[], approvedWorkspaces={},
                           hostPathMappings={})
        for isolation in ('local', 'worktree'):
            with self.subTest(isolation=isolation):
                self.workspaces[0].update(workspaceId='wks_future', isolation=isolation)
                self.assertEqual(self.runtime.current('wks_future', 'preview')['cwd'], self.cwd)

    def test_registered_policy_requires_verified_mount_metadata(self):
        self.config['workspacePolicy'] = 'registered'
        with self.assertRaisesRegex(ValueError, 'requires verified host bind mappings'):
            self.runtime.current('wks_site', 'preview')
        self.config.update(hostPathMappings={}, approvedWorkspaces={})
        self.workspaces[0]['cwd'] = '/unmounted/project'
        with self.assertRaisesRegex(ValueError, 'no verified host bind mapping'):
            self.runtime.current('wks_site', 'preview')

    def test_registered_policy_rejects_archived_and_symlink_workspaces(self):
        self.config.update(workspacePolicy='registered', allowedRoots=[], approvedWorkspaces={},
                           hostPathMappings={})
        self.workspaces[0]['archivedAt'] = '2026-09-29T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'Unknown, archived'):
            self.runtime.current('wks_site', 'preview')
        del self.workspaces[0]['archivedAt']
        self.path.rename(self.path.with_name('outside'))
        self.path.symlink_to(self.path.with_name('outside'), target_is_directory=True)
        with self.assertRaises(OSError):
            self.runtime.current('wks_site', 'preview')

    def test_registered_policy_reserves_ports_outside_legacy_roots(self):
        self.config.update(workspacePolicy='registered', allowedRoots=[], approvedWorkspaces={},
                           hostPathMappings={})
        (self.path / 'paseo.json').write_text(json.dumps({'scripts': {
            'preview': {'type': 'service', 'command': 'npm run dev', 'port': 40001}}}))
        self.assertEqual(self.runtime.registered_ports(), {40001})

    def test_local_config_overrides_fingerprint_and_ports(self):
        before = self.runtime.current('wks_site', 'preview')['fingerprint']
        (self.path / 'paseo.local.json').write_text(json.dumps({'scripts': {
            'preview': {'command': 'wrapped npm run dev', 'port': 40002}}}))
        self.assertNotEqual(self.runtime.current('wks_site', 'preview')['fingerprint'], before)
        self.assertEqual(self.runtime.registered_ports(), {40002})

    def test_unknown_policy_fails_closed(self):
        self.config['workspacePolicy'] = 'typo'
        with self.assertRaisesRegex(ValueError, 'Unsupported workspace policy'):
            self.runtime.current('wks_site', 'preview')

    def test_unapproved_worktree(self):
        self.config['approvedWorkspaces'] = {}
        with self.assertRaisesRegex(ValueError, 'explicit administrator approval'):
            self.runtime.current('wks_site', 'preview')

    def test_approved_worktree_outside_allowed_roots(self):
        self.config['allowedRoots'] = ['/another/root']
        with self.assertRaisesRegex(ValueError, 'outside administrator policy'):
            self.runtime.current('wks_site', 'preview')

    def test_moved_workspace(self):
        self.config['allowedRoots'] = ['/home/paseo/.paseo/worktrees']
        self.workspaces[0]['cwd'] += '-moved'
        with self.assertRaisesRegex(ValueError, 'workspace moved'):
            self.runtime.current('wks_site', 'preview')

    def test_unknown_or_archived_workspace(self):
        self.workspaces.clear()
        with self.assertRaisesRegex(ValueError, 'Unknown, archived'):
            self.runtime.current('wks_site', 'preview')

    def test_local_workspace_keeps_root_approval(self):
        self.workspaces[0]['isolation'] = 'local'
        self.config['approvedWorkspaces'] = {}
        self.assertEqual(self.runtime.current('wks_site', 'preview')['cwd'], self.cwd)

    def test_symlink_escape(self):
        self.path.rename(self.path.with_name('outside'))
        self.path.symlink_to(self.path.with_name('outside'), target_is_directory=True)
        with self.assertRaises(OSError):
            self.runtime.current('wks_site', 'preview')

    def test_translated_host_bind(self):
        self.cwd = '/shared/site'
        self.workspaces[0].update(cwd=self.cwd, isolation='local')
        self.config.update(allowedRoots=['/shared'], approvedWorkspaces={}, hostPathMappings={'/shared': str(self.path.parent)})
        self.assertEqual(self.runtime.current('wks_site', 'preview')['cwd'], self.cwd)

    def test_unmapped_and_traversal_paths(self):
        self.config['hostPathMappings'] = {}
        with self.assertRaisesRegex(ValueError, 'no verified host bind'):
            self.runtime.host_workspace('/unmapped/site')
        with self.assertRaisesRegex(ValueError, 'Invalid container workspace path'):
            self.runtime.host_workspace(self.cwd + '/../outside')

    def test_installer_approval_preserves_policy(self):
        spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-https-broker.py'))
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        self.config.update(allowedRoots=['/existing'], approvedWorkspaces={'wks_existing': '/existing'})
        policy = installer.approve_workspaces(self.config, ['wks_site=' + self.cwd], self.workspaces)
        self.assertEqual(policy, {'allowedRoots': ['/existing', self.cwd], 'approvedWorkspaces': {'wks_existing': '/existing', 'wks_site': self.cwd}})
        for approval in ['wks_site=/moved', 'wks_unknown=' + self.cwd, '../bad=' + self.cwd]:
            with self.assertRaises(ValueError):
                installer.approve_workspaces(self.config, [approval], self.workspaces)


class Fake:
    def __init__(self):
        self.config = {'TCP': {'44443': {'HTTPS': True}}, 'Web': {'test.example.ts.net:44443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:39000'}}}}}
        self.entry = dict(workspaceId='wks_test', service='preview', cwd='/approved', fingerprint='one', type='service', lifecycle='running', terminalId='one', port=33487)
        self.sets = 0
        self.starts = 0
        self.free_calls = []
        self.fail_verify = False
        self.daemon = 'boot:100:1'
    def daemon_identity(self): return self.daemon
    def preflight(self): pass
    def registered_ports(self): return {33487,39000}
    def current(self, w, s):
        if w != 'wks_test' or s != 'preview': raise ValueError('Unknown service')
        return copy.deepcopy(self.entry)
    def publication(self):
        if any(self.config.get('AllowFunnel', {}).values()): raise ValueError('Unexpected Funnel')
        return copy.deepcopy(self.config)
    def free(self, p, retained=False): self.free_calls.append(p)
    def backend_ready(self, p): pass
    def listener_identity(self, p, terminal): return terminal
    def lifecycle(self, op, e):
        self.entry['lifecycle'] = 'running' if op == 'start' else 'stopped'
        if op == 'start': self.starts += 1; self.entry['terminalId'] = str(self.starts)
        return copy.deepcopy(self.entry)
    def set_mapping(self, p, b):
        self.sets += 1
        self.config['TCP'][str(p)] = {'HTTPS': True}
        self.config['Web'][f'test.example.ts.net:{p}'] = {'Handlers': {'/': {'Proxy': f'http://127.0.0.1:{b}'}}}
    def remove_mapping(self, p):
        self.config['TCP'].pop(str(p), None); self.config['Web'].pop(f'test.example.ts.net:{p}', None)
    def verify(self, url):
        if self.fail_verify: raise subprocess.CalledProcessError(1, 'verify')


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        channel = self.root / 'channel'
        for n in ['', 'inbox', 'receipts', 'origins']: (channel/n).mkdir(exist_ok=True)
        self.c = {'deployment': str(self.root), 'channel': str(channel), 'hostname': 'test.example.ts.net', 'reservedPorts': [443,6767,44443], 'portStart':44444,'portEnd':44449, 'channelIdentities':{n:[(channel/n).stat().st_dev,(channel/n).stat().st_ino] for n in ['', 'inbox','receipts','origins']}}
        self.runtime = Fake(); self.b = Broker(self.c,self.runtime)
    def request(self, operation='start', **kw):
        return dict(id=str(uuid.uuid4()), operation=operation, workspaceId='wks_test',service='preview',createdAt=time.time(),**kw)
    def test_repeat_adopts_without_bind_or_set_again(self):
        one=self.b.handle(self.request()); calls=len(self.runtime.free_calls)
        two=self.b.handle(self.request()); self.assertEqual(one,two)
        self.assertEqual(self.runtime.sets,1);self.assertEqual(len(self.runtime.free_calls),calls)
    def test_reserved_and_other_route_preserved(self):
        before=copy.deepcopy(self.runtime.config)
        with self.assertRaises(ValueError):self.b.handle(self.request(preferredPort=44443))
        self.assertEqual(before,self.runtime.config)
    def test_funnel_preflight_no_mutation(self):
        self.runtime.config['AllowFunnel']={'host':True}
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)
    def test_stop_rejects_queued_start_and_recovery(self):
        self.b.handle(self.request());queued=self.request();self.b.handle(self.request('stop'))
        with self.assertRaises(ValueError):self.b.handle(queued)
        self.b.reconcile();self.assertEqual(self.runtime.starts,0);self.assertNotIn('44444',self.runtime.config['TCP'])
        self.assertEqual(self.b.handle(self.request())['frontendPort'],44444)
    def test_backend_reuse_fails_closed(self):
        self.b.handle(self.request());self.runtime.entry['terminalId']='different-process'
        self.b.reconcile();self.assertNotIn('44444',self.runtime.config['TCP']);self.assertEqual(self.runtime.starts,0)
    def test_configuration_change_recovery_does_not_start(self):
        self.b.handle(self.request());self.runtime.entry['fingerprint']='changed'
        self.b.reconcile();self.assertEqual(self.runtime.starts,0);self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_unknown_arbitrary_and_expired(self):
        for modify in [dict(service='other'),dict(url='http://evil'),dict(createdAt=time.time()-200),dict(preferredPort=6767),dict(workspaceId='../evil')]:
            r=self.request();r.update(modify)
            with self.assertRaises(ValueError):self.b.handle(r)
        self.assertEqual(self.runtime.sets,0)
    def test_failed_verification_removes_mapping(self):
        self.runtime.fail_verify=True
        self.assertEqual(self.b.handle(self.request())['status'],'pending')
        self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_external_conflict_never_removed(self):
        self.b.handle(self.request());self.runtime.config['Web']['test.example.ts.net:44444']['Handlers']['/']['Proxy']='http://127.0.0.1:55555'
        with self.assertRaises(ValueError):self.b.handle(self.request('stop'))
        self.assertIn('44444',self.runtime.config['TCP'])
    def test_symlink_and_oversize(self):
        outside=self.root/'protected';outside.write_text('{}');p=self.root/'link';p.symlink_to(outside)
        with self.assertRaises(OSError):safe_read(p)
        p.unlink();p.write_text('x'*5000)
        with self.assertRaises(ValueError):safe_read(p,4096)
        directory=self.root/'dirlink';directory.symlink_to(self.root/'channel',target_is_directory=True)
        with self.assertRaises(OSError):atomic(directory/'bad',{})
    def test_queue_dedup_stop_priority_and_receipts(self):
        self.b.handle(self.request());start=self.request();stop=self.request('stop')
        for r in [start,stop]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run();self.assertEqual(self.runtime.starts,0)
        receipt=safe_read(Path(self.c['channel'])/'receipts'/(start['id']+'.json'));self.assertEqual(receipt['status'],'failed')
        atomic(Path(self.c['channel'])/'inbox'/(start['id']+'.json'),start);self.b.run();self.assertEqual(self.runtime.starts,0)
    def test_replaced_channel_rejected(self):
        p=Path(self.c['channel'])/'inbox';p.rename(p.with_name('old'));p.mkdir()
        with self.assertRaises(ValueError):self.b.run()
    def test_occupied_frontend(self):
        def occupied(p):raise subprocess.CalledProcessError(1,'bind')
        self.runtime.free=occupied
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)
    def test_control_plane_backend(self):
        self.runtime.entry['port']=6767
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)

    def test_high_ephemeral_backend_keeps_frontend_reservation(self):
        for port in (60999, 61000, 61983, 65535):
            with self.subTest(port=port):
                self.runtime.entry['port'] = port
                result = self.b.handle(self.request('restart'))
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(result['backendPort'], port)
                self.assertEqual(result['frontendPort'], 44444)
                route = self.runtime.config['Web']['test.example.ts.net:44444']
                self.assertEqual(route['Handlers']['/']['Proxy'], f'http://127.0.0.1:{port}')

    def test_invalid_and_frontend_backend_ports_stay_rejected(self):
        for port in (None, True, '61983', 32767, 65536, 44444):
            with self.subTest(port=port):
                self.runtime.entry['port'] = port
                with self.assertRaisesRegex(ValueError, 'Backend allocation'):
                    self.b.handle(self.request('restart', preferredPort=44444))
                self.assertEqual(self.runtime.sets, 0)

    def test_concurrent_consumer_lock_and_multiple_starts(self):
        import fcntl
        r1=self.request();r2=self.request()
        for r in [r1,r2]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        with (self.root/'https-broker.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):Broker(self.c,self.runtime).run()
        self.b.run();self.assertEqual(self.runtime.sets,1)
    def test_malicious_receipt_symlink_does_not_overwrite_target(self):
        r=self.request();target=self.root/'protected';target.write_text('unchanged')
        receipt=Path(self.c['channel'])/'receipts'/(r['id']+'.json');receipt.symlink_to(target)
        atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run();self.assertEqual(target.read_text(),'unchanged');self.assertFalse(receipt.is_symlink())
    def test_listener_reuse_same_terminal_is_rejected(self):
        self.b.handle(self.request());self.runtime.listener_identity=lambda p,t:'other-listener'
        self.b.reconcile();self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_recovery_adopts_same_process_without_new_mapping(self):
        self.b.handle(self.request());Broker(self.c,self.runtime).reconcile()
        self.assertEqual(self.runtime.sets,1);self.assertEqual(self.runtime.starts,0)

    def test_opted_in_preview_recovers_after_daemon_restart(self):
        self.c['restoreAfterRestart'] = True
        before = self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry.update(lifecycle='stopped', terminalId=None, port=33488)
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual(entry['status'], 'ready')
        self.assertEqual(entry['frontend'], before['frontendPort'])
        self.assertEqual(entry['backend'], 33488)
        self.assertEqual(self.runtime.starts, 1)
        self.assertEqual(self.runtime.config['Web']['test.example.ts.net:44443']['Handlers']['/']['Proxy'], 'http://127.0.0.1:39000')

    def test_explicit_stop_stays_stopped_across_restart(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.b.handle(self.request('stop'))
        self.runtime.daemon = 'new-boot:100:1'
        Broker(self.c, self.runtime).reconcile()
        self.assertEqual(self.runtime.starts, 0)
        self.assertEqual(safe_read(self.b.ledger_path)['entries']['wks_test.preview']['desired'], 'stopped')
        self.assertNotIn('44444', self.runtime.config['TCP'])

    def test_stopped_service_in_same_daemon_is_not_revived(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.entry['lifecycle'] = 'stopped'
        self.b.reconcile()
        self.runtime.daemon = 'boot:200:2'
        self.b.reconcile()
        self.assertEqual(self.runtime.starts, 0)

    def prepare_recovery(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry['lifecycle'] = 'stopped'

    def assert_recovery_rejected(self):
        self.b.reconcile()
        self.assertEqual(self.runtime.starts, 0)
        self.assertNotIn('44444', self.runtime.config['TCP'])
        self.assertEqual(self.b.ledger['entries']['wks_test.preview']['desired'], 'stopped')

    def test_archived_workspace_is_not_recovered(self):
        self.prepare_recovery()
        def archived(w, s): raise ValueError('Unknown, archived or unsupported workspace')
        self.runtime.current = archived
        self.assert_recovery_rejected()

    def test_moved_workspace_is_not_recovered(self):
        self.prepare_recovery()
        self.runtime.entry['cwd'] = '/different'
        self.assert_recovery_rejected()

    def test_reconfigured_service_is_not_recovered(self):
        self.prepare_recovery()
        self.runtime.entry['fingerprint'] = 'different'
        self.assert_recovery_rejected()

    def test_running_replacement_after_restart_is_not_adopted(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry['terminalId'] = 'unrecognized'
        self.b.reconcile()
        self.assertEqual(self.runtime.starts, 0)
        self.assertNotIn('44444', self.runtime.config['TCP'])

    def test_recovery_retries_are_bounded_and_persist_across_broker_runs(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry['lifecycle'] = 'stopped'
        calls = []
        def unavailable(op, entry):
            calls.append(op)
            raise subprocess.TimeoutExpired('start', 12)
        self.runtime.lifecycle = unavailable
        self.b.reconcile()
        self.assertEqual(calls, ['start'])
        Broker(self.c, self.runtime).reconcile()
        self.assertEqual(calls, ['start'])
        for attempt in range(1, 3):
            broker = Broker(self.c, self.runtime)
            broker.ledger['entries']['wks_test.preview']['recovery']['retryAt'] = 0
            broker.save()
            broker.reconcile()
            self.assertEqual(len(calls), attempt + 1)
            Broker(self.c, self.runtime).reconcile()
            self.assertEqual(len(calls), attempt + 1)
        self.assertNotIn('44444', self.runtime.config['TCP'])
        self.assertEqual(safe_read(self.b.ledger_path)['entries']['wks_test.preview']['status'], 'pending')

    def test_slow_start_verification_does_not_launch_twice(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry.update(lifecycle='stopped', port=33488)
        self.runtime.fail_verify = True
        self.b.reconcile()
        self.runtime.fail_verify = False
        Broker(self.c, self.runtime).reconcile()
        self.assertEqual(self.runtime.starts, 1)
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual(entry['status'], 'ready')
        self.assertEqual(entry['daemon'], self.runtime.daemon)
        self.assertNotIn('recovery', entry)

    def test_legacy_stopped_reservation_is_not_revived_when_enabling_recovery(self):
        self.b.handle(self.request())
        self.c['restoreAfterRestart'] = True
        self.runtime.entry['lifecycle'] = 'stopped'
        self.b.reconcile()
        self.assertEqual(self.runtime.starts, 0)

    def test_restart_recovery_preserves_foreign_route_conflict(self):
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry['lifecycle'] = 'stopped'
        self.runtime.config['Web']['test.example.ts.net:44444']['Handlers']['/']['Proxy'] = 'http://127.0.0.1:55555'
        before = copy.deepcopy(self.runtime.config)
        self.b.reconcile()
        self.assertEqual(self.runtime.starts, 0)
        self.assertEqual(self.runtime.config, before)

    def test_stop_queued_during_restart_wins_over_recovery(self):
        self.prepare_recovery()
        stop = self.request('stop')
        atomic(Path(self.c['channel']) / 'inbox' / (stop['id'] + '.json'), stop)
        self.b.run()
        self.assertEqual(self.runtime.starts, 0)
        self.assertEqual(self.b.ledger['entries']['wks_test.preview']['desired'], 'stopped')

    def test_recovery_does_not_adopt_start_with_lost_acknowledgement(self):
        self.prepare_recovery()
        start = self.runtime.lifecycle
        def lost_response(op, entry):
            start(op, entry)
            raise subprocess.TimeoutExpired('start', 12)
        self.runtime.lifecycle = lost_response
        self.b.reconcile()
        Broker(self.c, self.runtime).reconcile()
        self.assertEqual(self.runtime.starts, 1)
        self.assertNotIn('44444', self.runtime.config['TCP'])
        self.assertEqual(safe_read(self.b.ledger_path)['entries']['wks_test.preview']['desired'], 'stopped')

    def test_daemon_change_during_verification_never_returns_ready(self):
        self.c['restoreAfterRestart'] = True
        identities = iter(['boot:100:1', 'boot:200:2'])
        self.runtime.daemon_identity = lambda: next(identities)
        with self.assertRaisesRegex(RuntimeError, 'Daemon changed during verification'):
            self.b.handle(self.request())
        self.assertNotIn('44444', self.runtime.config['TCP'])

    def test_two_queued_services_receive_distinct_stable_ports(self):
        original=self.runtime.current
        def current(w,s):
            if w=='wks_other':
                entry=original('wks_test',s);entry.update(workspaceId=w,port=33488,terminalId='two');return entry
            return original(w,s)
        self.runtime.current=current
        r1=self.request();r2=self.request();r2['workspaceId']='wks_other'
        for r in [r1,r2]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run()
        fronts=[e['frontend'] for e in self.b.ledger['entries'].values()]
        self.assertEqual(sorted(fronts),[44444,44445])

    def test_changed_live_configuration_requires_restart(self):
        self.b.handle(self.request());self.runtime.entry['fingerprint']='changed'
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertNotIn('44444',self.runtime.config['TCP'])

if __name__=='__main__':unittest.main()
