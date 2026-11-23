import copy
import ctypes
import importlib.util
import json
import os
import socket
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
from https_broker import Broker, ListenerLost, Runtime, NativeRuntime, WorkspaceUnavailable, public_error, RESTART_ATTRIBUTION_SECONDS, STATUS_FIELDS, STATUS_FILE, _libproc_socket_types, atomic, loopback_listener_port, safe_read, validate


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
                def verify_node(self): replaced.append('preflight')
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
        # The CLI is pinned through its stable link, not the release an update will replace,
        # so a reinstall after an update still matches the existing pin.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(os.path.realpath(directory))
            for release in ('release-1', 'release-2'):
                (base / release / 'bin').mkdir(parents=True); (base / release / 'bin' / 'paseo').write_text('')
            current = base / 'current'; current.symlink_to(base / 'release-1')
            pinned = installer.stable_path(current / 'bin' / 'paseo')
            self.assertEqual(pinned, str(current / 'bin' / 'paseo'))
            current.unlink(); current.symlink_to(base / 'release-2')
            self.assertEqual(installer.stable_path(current / 'bin' / 'paseo'), pinned)
            installer.check_identity({**old, 'cliCommand': ['/node', pinned]},
                                     {**old, 'cliCommand': ['/node', installer.stable_path(current / 'bin' / 'paseo')]},
                                     running, False, nothing)
            for bad in ('relative/paseo', str(base / 'current' / '..' / 'release-1' / 'bin' / 'paseo'), str(base / 'missing')):
                with self.assertRaises(ValueError):
                    installer.stable_path(bad)
        # An existing broker directory that others can write is refused, never adopted.
        with tempfile.TemporaryDirectory() as directory:
            fresh = installer.prepare_deployment(Path(os.path.realpath(directory)) / 'new')
            self.assertEqual(os.lstat(fresh).st_mode & 0o777, 0o700)
            open_root = Path(os.path.realpath(directory)) / 'open'; open_root.mkdir(); open_root.chmod(0o777)
            with self.assertRaises(ValueError):
                installer.prepare_deployment(open_root)
        # Leaving a node needs its identity and publication, not its access scope: adding the
        # new node to the tailnet has usually changed the old node's filter already.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(os.path.realpath(directory)) / 'broker'; channel = root / 'channel'
            (channel / 'origins').mkdir(parents=True); root.chmod(0o700)
            atomic(root / 'host-config.json', old)
            atomic(root / 'https-broker-ledger.json', stopped)
            class ScopeChangedNode:
                def __init__(self, config): pass
                def verify_node(self): pass
                def preflight(self): raise ValueError('Tailnet access scope changed; administrator review required')
                def publication(self): return {}
            installer.switch_pins(root, channel, new, True, lambda: None, ScopeChangedNode)
            self.assertEqual(safe_read(root / 'host-config.json'), new)
        # The same node with a changed access scope is re-pinned only on request, and the
        # request never covers a different node.
        rescoped = {**old, 'packetFilterHash': 'changed'}
        with self.assertRaises(ValueError):
            installer.check_identity(old, rescoped, running, False, nothing)
        installer.check_identity(old, rescoped, running, False, nothing, accept_scope=True)
        with self.assertRaises(ValueError):
            installer.check_identity(old, {**rescoped, 'nodeId': 'other'}, stopped, False, nothing, accept_scope=True)
        # Accepting a scope on the same node keeps the reservations running previews rely on.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(os.path.realpath(directory)) / 'broker'; channel = root / 'channel'
            (channel / 'origins').mkdir(parents=True); root.chmod(0o700)
            origin = channel / 'origins' / 'w.s.json'; origin.write_text('{}')
            atomic(root / 'host-config.json', old)
            atomic(root / 'https-broker-ledger.json', running)
            installer.switch_pins(root, channel, rescoped, False, lambda: None, accept_scope=True)
            self.assertEqual(safe_read(root / 'host-config.json'), rescoped)
            self.assertTrue(origin.exists())
        # What is accepted is shown grant by grant, with device names, so it can be judged.
        rule = lambda source, first, last: {'Srcs': [source], 'IPProto': [6],
                                            'Dsts': [{'Net': '100.64.0.1/32', 'Ports': {'First': first, 'Last': last}}]}
        names = installer.device_names({'Self': {'DNSName': 'mac.ts.net.', 'TailscaleIPs': ['100.64.0.1']},
                                        'Peer': {'k': {'DNSName': 'previews.ts.net.', 'TailscaleIPs': ['100.64.0.9']}}})
        scope = lambda *rules: {'accessScope': installer.access_scope(list(rules))}
        # Two sources swap what they may reach. Sets of sources and destinations are equal,
        # yet one source gains every port, and the summary must say so.
        before = scope(rule('100.64.0.9/32', 443, 443), rule('100.64.0.3/32', 0, 65535))
        after = scope(rule('100.64.0.9/32', 0, 65535), rule('100.64.0.3/32', 443, 443))
        change = installer.scope_change(before, after, names)
        gained = [grant for grant in change['addedGrants'] if grant['source'] == '100.64.0.9/32']
        self.assertEqual([(grant['ports'], grant['sourceDevice'], grant['destinationDevice']) for grant in gained],
                         [('0-65535', 'previews', 'mac')])
        self.assertEqual(len(change['addedGrants']), 2); self.assertEqual(len(change['removedGrants']), 2)
        self.assertEqual({grant['sourceDevice'] for grant in change['removedGrants']}, {'previews', 'unknown device'})
        # A protocol or other rule field is part of a grant too.
        widened = scope({**rule('100.64.0.9/32', 443, 443), 'IPProto': [6, 17]})
        self.assertEqual(len(installer.scope_change(scope(rule('100.64.0.9/32', 443, 443)), widened, names)['addedGrants']), 1)
        # A changed hash with no grant difference, and an install with no earlier record,
        # are stated as such with the full picture, never as "nothing changed".
        raw = [rule('100.64.0.9/32', 443, 443)]
        same = installer.scope_change(before, before, names, raw)
        self.assertIn('not represented', same['comparison']); self.assertEqual(same['rawRules'], raw)
        first = installer.scope_change({}, before, names)
        self.assertIn('no earlier record', first['comparison']); self.assertEqual(len(first['allGrants']), 2)
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

    def test_native_in_process_checks_without_libproc(self):
        # Runs on every platform: real structure types, stubbed kernel answers.
        _, SocketFDInfo = _libproc_socket_types()
        def socket_record(state=1, vflag=1, address=(127, 0, 0, 1), kind=2, reuse=False, port=40001):
            info = SocketFDInfo()
            info.psi.soi_kind = kind
            info.psi.soi_options = 0x0200 if reuse else 0
            tcp = info.psi.soi_proto.pri_tcp
            tcp.tcpsi_state = state
            tcp.tcpsi_ini.insi_vflag = vflag
            tcp.tcpsi_ini.insi_lport = socket.htons(port)
            for index, byte in enumerate(address): tcp.tcpsi_ini.insi_laddr.ina_46.i46a_addr4[index] = byte
            return info
        size = ctypes.sizeof(SocketFDInfo)
        cases = [
            ({}, (40001, False)),
            ({'state': 4}, None),  # an accepted connection on the backend port is not a listener
            ({'vflag': 2}, None),  # IPv6 socket whose IPv4 view happens to read 127.0.0.1
            ({'address': (0, 0, 0, 0)}, None),  # wildcard
            ({'kind': 1}, None),  # not TCP
            ({'reuse': True}, (40001, True)),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                self.assertEqual(loopback_listener_port(socket_record(**fields), size), expected)
        with self.assertRaisesRegex(OSError, 'layout'):
            loopback_listener_port(socket_record(), size - 8)

        runtime = NativeRuntime({})
        runtime.loopback_listening_ports = lambda pid: {40001: False}
        self.assertTrue(runtime.in_process_check_agrees(40001, '123:1:2'))
        self.assertFalse(runtime.in_process_check_agrees(40002, '123:1:2'))
        runtime.loopback_listening_ports = lambda pid: {40001: True}
        self.assertFalse(runtime.in_process_check_agrees(40001, '123:1:2'))  # shared port
        def unevaluable(pid): raise OSError('Unexpected socket_fdinfo layout')
        runtime.loopback_listening_ports = unevaluable
        self.assertFalse(runtime.in_process_check_agrees(40001, '123:1:2'))
        # agree_always_true: a check that says yes for every port never agrees.
        runtime.loopback_listening_ports = lambda pid: {40001: False}
        runtime.loopback_listener_held = lambda pid, port: True
        self.assertFalse(runtime.in_process_check_agrees(40001, '123:1:2'))

        recheck = NativeRuntime({})
        recorded = {'listener': '123:1:2', 'terminal': 'terminal_fixture', 'backend': 40001}
        recheck.process_identity = lambda pid: {'pid': pid, 'parent': 1, 'birth': '1:2'}
        recheck.loopback_listening_ports = lambda pid: {40001: False}
        def unreadable(pid): raise ValueError('Listener environment unavailable')
        recheck.terminal_environment = unreadable
        # An unreadable environment is a lost listener, never an identity change that stops the preview.
        with self.assertRaisesRegex(ListenerLost, 'environment unavailable'):
            recheck.listener_unchanged(recorded)
        recheck.terminal_environment = lambda pid: 'terminal_other'
        with self.assertRaisesRegex(ValueError, 'managed terminal'):
            recheck.listener_unchanged(recorded)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS process ownership probe')
    def test_real_native_listener_identity(self):
        # Disposable HTTP fixture only; never start or stop an installed daemon.
        runtime = NativeRuntime({})
        code = ('import socket,sys,time; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); '
                'print(s.getsockname()[1],flush=True); c,_=s.accept(); print("accepted",flush=True); '
                'sys.stdin.readline(); s.close(); print("closed",flush=True); time.sleep(30)')
        process = subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                   env={**os.environ, 'PASEO_TERMINAL_ID': 'terminal_fixture'})
        client = None
        try:
            port = int(process.stdout.readline())
            client = socket.create_connection(('127.0.0.1', port), timeout=5)
            self.assertEqual(process.stdout.readline().strip(), 'accepted')
            identity = runtime.listener_identity(port, 'terminal_fixture')
            self.assertTrue(identity.startswith(str(process.pid) + ':'))
            self.assertEqual(runtime.listener_identity(port, 'terminal_fixture'), identity)
            with self.assertRaisesRegex(ValueError, 'managed terminal'):
                runtime.listener_identity(port, 'terminal_other')
            # The in-process recheck used during a timeout grace: no subprocess,
            # and its libproc socket layout agrees with what lsof just proved.
            recorded = {'listener': identity, 'terminal': 'terminal_fixture', 'backend': port}
            self.assertTrue(runtime.in_process_check_agrees(port, identity))
            self.assertFalse(runtime.in_process_check_agrees(port + 1 if port < 65535 else port - 1, identity))
            self.assertTrue(runtime.listener_unchanged(recorded))
            with self.assertRaisesRegex(ValueError, 'managed terminal'):
                runtime.listener_unchanged({**recorded, 'terminal': 'terminal_other'})
            process.stdin.write('\n'); process.stdin.flush(); process.stdout.readline()
            # Alive with the same identity and an accepted connection still open on
            # the backend port, but no longer listening: the listener is lost.
            with self.assertRaisesRegex(ListenerLost, 'loopback port'):
                runtime.listener_unchanged(recorded)
        finally:
            if client: client.close()
            process.kill()
            process.wait(timeout=5)
            process.stdout.close(); process.stdin.close()
        with self.assertRaisesRegex(ListenerLost, 'exited'):
            runtime.listener_unchanged(recorded)
        # A wildcard bind is not the loopback address the route proxies to, and a
        # listener that allows shared-port binding cannot be vouched for: neither earns grace.
        variants = {'wildcard': code.replace('"127.0.0.1"', '"0.0.0.0"'),
                    'shared': code.replace('s.bind(', 's.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEPORT,1); s.bind(')}
        for name, variant in variants.items():
            other = subprocess.Popen([sys.executable, '-c', variant], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                port = int(other.stdout.readline())
                self.assertFalse(runtime.in_process_check_agrees(port, f'{other.pid}:0'), name)
                if name == 'shared':
                    with self.assertRaisesRegex(OSError, 'Shared-port'):
                        runtime.loopback_listener_held(other.pid, port)
            finally:
                other.kill(); other.wait(timeout=5); other.stdout.close(); other.stdin.close()

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
            # A stop still finds the archived workspace's service by its exact name.
            self.assertEqual(runtime.stoppable('wks_native', 'preview')['scriptName'], 'preview')
            with self.assertRaisesRegex(ValueError, 'could not be found to stop'):
                runtime.stoppable('wks_native', 'other')
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


    def test_installer_accepts_reviewed_scope_on_same_node_only(self):
        spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-https-broker.py'))
        installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
        rule = lambda source: {'Srcs': [source], 'IPProto': [6],
                               'Dsts': [{'Net': '100.64.0.1/32', 'Ports': {'First': 32768, 'Last': 60999}}]}
        status = {'Self': {'DNSName': 'aubrey.ts.net.', 'TailscaleIPs': ['100.64.0.1']},
                  'Peer': {'k': {'DNSName': 'previews.ts.net.', 'TailscaleIPs': ['100.64.0.9']}}}
        before_rules, after_rules = [rule('100.64.0.3/32')], [rule('100.64.0.3/32'), rule('100.64.0.9/32')]
        pinned = lambda **change: {'nodeId': 'n1', 'hostname': 'aubrey.ts.net', 'packetFilterHash': 'old', **change}
        old = pinned(accessScope=installer.access_scope(before_rules))
        self.assertIsNone(installer.pin_network(old, pinned(), status, before_rules))
        self.assertIsNone(installer.pin_network({}, pinned(packetFilterHash='new'), status, after_rules))
        # A changed scope on the same node refuses without the flag, printing what it would accept.
        with self.assertRaisesRegex(ValueError, '--accept-access-scope') as refused:
            installer.pin_network(old, pinned(packetFilterHash='new'), status, after_rules)
        self.assertIn('"sourceDevice": "previews"', str(refused.exception))
        config = pinned(packetFilterHash='new')
        accepted = installer.pin_network(old, config, status, after_rules, accept_scope=True)
        self.assertEqual([(grant['source'], grant['sourceDevice'], grant['destinationDevice']) for grant in accepted['addedGrants']],
                         [('100.64.0.9/32', 'previews', 'aubrey')])
        self.assertEqual(accepted['removedGrants'], [])
        self.assertEqual(config['accessScope'], installer.access_scope(after_rules))
        # The flag never covers a different node or hostname.
        for other in (pinned(packetFilterHash='new', nodeId='n2'), pinned(packetFilterHash='new', hostname='other.ts.net'),
                      pinned(nodeId='n2')):
            with self.assertRaisesRegex(ValueError, 'network identity'):
                installer.pin_network(old, other, status, after_rules, accept_scope=True)
        # A config pinned before access scopes were recorded lists every current grant.
        legacy = {key: old[key] for key in ('nodeId', 'hostname', 'packetFilterHash')}
        first = installer.pin_network(legacy, pinned(packetFilterHash='new'), status, after_rules, accept_scope=True)
        self.assertIn('no earlier record', first['comparison']); self.assertEqual(len(first['allGrants']), 2)
        # The commit happens under the broker's own lock, against the config that was checked.
        from channel_identity import broker_lock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(os.path.realpath(directory)); root.chmod(0o700)
            atomic(root / 'host-config.json', old)
            replaced = []
            installer.commit_under_lock(root, old, config, lambda: replaced.append('first'))
            self.assertEqual((safe_read(root / 'host-config.json'), replaced), (config, ['first']))
            with self.assertRaisesRegex(ValueError, 'changed during install'):
                installer.commit_under_lock(root, old, pinned(packetFilterHash='other'), lambda: replaced.append('stale'))
            with broker_lock(root):
                with self.assertRaisesRegex(ValueError, 'busy'):
                    installer.commit_under_lock(root, config, config, lambda: replaced.append('busy'), wait=0.2)
            self.assertEqual((safe_read(root / 'host-config.json'), replaced), (config, ['first']))


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
    daemon_started = 0.0
    def daemon_worker(self): return {'identity': self.daemon, 'startedAt': self.daemon_started}
    def preflight(self): pass
    def registered_ports(self): return {33487,39000}
    # 'archived': start policy refuses the workspace; 'missing': the daemon no longer knows it.
    workspace_state = 'available'
    def current(self, w, s):
        if self.workspace_state != 'available': raise WorkspaceUnavailable('Unknown, archived or unsupported workspace')
        if w != 'wks_test' or s != 'preview': raise ValueError('Unknown service')
        return copy.deepcopy(self.entry)
    def stoppable(self, w, s):
        if self.workspace_state == 'missing' or w != 'wks_test' or s != 'preview':
            return Runtime.stoppable(self, w, s)
        return copy.deepcopy(self.entry)
    def cli(self, args): raise ValueError('Native daemon CLI refused the preview operation')
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
    # The in-process recheck during a timeout grace: 'same', 'exited', 'terminal',
    # 'closed' (alive but no longer listening) or 'error' (cannot evaluate).
    listener_state = 'same'
    agrees = True
    def listener_unchanged(self, entry):
        state = self.listener_state
        if state == 'exited': raise ListenerLost('Backend listener process exited')
        if state == 'closed': raise ListenerLost('Backend listener no longer holds its loopback port')
        if state == 'terminal': raise ValueError('Listener is not owned by the managed terminal')
        if state == 'error': raise OSError('Unexpected socket_fdinfo layout')
        return True
    def in_process_check_agrees(self, port, listener): return self.agrees


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
    def test_stop_in_unavailable_workspace_still_ends_the_service(self):
        # Stopping is always safe, so start policy for an archived workspace must not keep it running.
        self.b.handle(self.request()); self.runtime.workspace_state = 'archived'
        self.assertEqual(self.b.handle(self.request('stop')), {'status': 'stopped'})
        self.assertEqual(self.runtime.entry['lifecycle'], 'stopped')
        self.assertNotIn('44444', self.runtime.config['TCP'])
        # A workspace the daemon no longer knows cannot name its service: say so, in a fixed message.
        self.runtime.entry['lifecycle'] = 'running'; self.runtime.workspace_state = 'missing'
        with self.assertRaises(WorkspaceUnavailable) as raised: self.b.handle(self.request('stop'))
        self.assertEqual(public_error(str(raised.exception)), str(raised.exception))
        self.assertEqual(self.b.ledger['entries']['wks_test.preview']['desired'], 'stopped')
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
    def test_check_timeouts_keep_route_only_within_grace(self):
        def timeout(p): raise subprocess.TimeoutExpired('curl', 3)
        def refused(p): raise subprocess.CalledProcessError(7, 'curl')
        def timing_out(state):
            return lambda b, rt: (setattr(rt, 'backend_ready', timeout), setattr(rt, 'listener_state', state))
        def ledger_entry(b): return b.ledger['entries']['wks_test.preview']
        container = lambda rt: (setattr(rt, 'listener_unchanged', lambda e: Runtime.listener_unchanged(rt, e)),
                                setattr(rt, 'in_process_check_agrees', lambda p, l: Runtime.in_process_check_agrees(rt, p, l)))
        steps = {
            'ok': lambda b, rt: (setattr(rt, 'backend_ready', lambda p: None), setattr(rt, 'listener_state', 'same')),
            'timeout': timing_out('same'),
            'refused': lambda b, rt: setattr(rt, 'backend_ready', refused),
            'terminal': timing_out('terminal'),  # a live process now claims another terminal
            'exited': timing_out('exited'),
            'closed': timing_out('closed'),  # alive, same identity, no longer listening
            'unevaluable': timing_out('error'),
            'stale': lambda b, rt: (setattr(rt, 'backend_ready', timeout), ledger_entry(b).update(verifiedAt=time.time() - 91)),
            'clock back': lambda b, rt: (setattr(rt, 'backend_ready', timeout), ledger_entry(b).update(verifiedAt=time.time() + 60)),
            'disagreeing ok': lambda b, rt: (setattr(rt, 'backend_ready', lambda p: None), setattr(rt, 'agrees', False)),
            'stop': lambda b, rt: b.handle(self.request('stop')),
        }
        # setup, steps, then (route published, ledger status, desired, misses)
        cases = [
            (None, ['timeout'], (True, 'unverified', 'running', 1)),
            (None, ['timeout'] * 3, (False, 'failed', 'running', None)),
            (None, ['timeout'] * 3 + ['ok'], (True, 'ready', 'running', None)),
            (None, ['stale'], (False, 'failed', 'running', None)),
            (None, ['clock back'], (False, 'failed', 'running', None)),
            (None, ['timeout', 'timeout', 'ok', 'timeout', 'timeout'], (True, 'unverified', 'running', 2)),
            (None, ['timeout', 'terminal'], (False, 'failed', 'stopped', None)),
            (None, ['timeout', 'refused'], (False, 'failed', 'running', None)),
            # A process that exits or closes its port withdraws at once but keeps the
            # running intent, so the next clean check republishes it.
            (None, ['timeout', 'exited'], (False, 'failed', 'running', None)),
            (None, ['timeout', 'closed'], (False, 'failed', 'running', None)),
            (None, ['timeout', 'closed', 'ok'], (True, 'ready', 'running', None)),
            (None, ['unevaluable'], (False, 'failed', 'running', None)),
            (None, ['disagreeing ok', 'timeout'], (False, 'failed', 'running', None)),
            (container, ['timeout'], (False, 'failed', 'running', None)),
            (None, ['timeout', 'stop'], (False, 'stopped', 'stopped', None)),
        ]
        for driver in ('reconcile', 'status'):
            for setup, sequence, expected in cases:
                with self.subTest(driver=driver, sequence=sequence, container=setup is not None):
                    runtime = Fake(); broker = Broker(self.c, runtime)
                    broker.ledger = {'entries': {}, 'requests': {}}
                    if setup: setup(runtime)
                    broker.handle(self.request())
                    for step in sequence:
                        steps[step](broker, runtime)
                        if driver == 'reconcile':
                            broker.reconcile()
                        else:
                            try: result = broker.handle(self.request('status'))
                            except Exception: result = {'status': 'failed'}
                            # An unverified route is never reported as ready or with its URL.
                            if step not in ('ok', 'disagreeing ok'): self.assertNotIn('url', result)
                    entry = safe_read(broker.ledger_path)['entries']['wks_test.preview']
                    self.assertEqual(('44444' in runtime.config['TCP'], entry['status'], entry['desired'], entry.get('misses')), expected)
                    if expected[1] == 'unverified': self.assertIn('unverified', entry['error'])
                    if not expected[0]: self.assertNotIn('url', entry)
                    if expected[1] == 'stopped': self.assertNotIn('error', entry)
                    lost = {'exited': 'Backend listener process exited', 'closed': 'Backend listener no longer holds its loopback port'}
                    if sequence[-1] in lost: self.assertEqual(entry['error'], lost[sequence[-1]])
                    if not expected[0] and sequence[-1] in ('timeout', 'stale', 'clock back', 'unevaluable'):
                        self.assertIn('timed out', entry['error'])

    def test_restart_recovery_survives_a_timed_out_identity_check(self):
        # restore-after-restart on; the daemon restart kills the service, and the
        # next cycle's daemon identity call times out. The route is withdrawn, but
        # recovery still brings the preview back after a clean cycle, as on main.
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry.update(lifecycle='stopped', terminalId=None, port=33488)
        self.runtime.listener_state = 'exited'
        def slow(): raise subprocess.TimeoutExpired('lsof', 12)
        self.runtime.daemon_identity = slow
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['desired'], entry['status']), ('running', 'failed'))
        self.assertNotIn('44444', self.runtime.config['TCP'])
        del self.runtime.daemon_identity
        self.runtime.listener_state = 'same'
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['status'], entry['backend'], self.runtime.starts), ('ready', 33488, 1))
        self.assertIn('44444', self.runtime.config['TCP'])

    def test_timed_out_cleanup_removal_keeps_the_definite_error(self):
        # The daemon changes during verification and the cleanup removal times out:
        # the recovery decision stands with the removal pending, and no grace starts.
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        calls = iter(['boot:100:1', 'boot:100:1', 'boot:200:2'])
        self.runtime.daemon_identity = lambda: next(calls, 'boot:200:2')
        def slow(p): raise subprocess.TimeoutExpired('tailscale', 12)
        self.runtime.remove_mapping = slow
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['status'], entry['error'], entry.get('removalPending')), ('pending', 'Daemon changed during verification', True))
        self.assertNotIn('misses', entry); self.assertNotIn('url', entry)
        self.assertIn('44444', self.runtime.config['TCP'])  # still published until a removal succeeds

    def test_timed_out_stale_route_removal_after_restart_keeps_recovery_pending(self):
        # After a daemon restart the stale route must go before recovery starts the
        # service. If that removal times out, recovery stays pending with the removal
        # pending, the service is not started and no grace begins.
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry.update(lifecycle='stopped', terminalId=None, port=33488)
        def slow(p): raise subprocess.TimeoutExpired('tailscale', 12)
        self.runtime.remove_mapping = slow
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['status'], entry['error'], entry.get('removalPending'), entry['desired']),
                         ('pending', 'Removing the stale route after a daemon restart is pending', True, 'running'))
        self.assertNotIn('misses', entry); self.assertNotIn('url', entry); self.assertEqual(self.runtime.starts, 0)

    def test_start_during_timeout_grace_starts_a_fresh_count(self):
        self.b.handle(self.request())
        def timeout(p): raise subprocess.TimeoutExpired('curl', 3)
        self.runtime.backend_ready = timeout
        self.b.reconcile()
        self.assertEqual(safe_read(self.b.ledger_path)['entries']['wks_test.preview']['misses'], 1)
        result = self.b.handle(self.request())
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        # An explicit start under load still withdraws an unproven route, as before.
        self.assertEqual(result['status'], 'pending'); self.assertNotIn('url', result)
        self.assertNotIn('misses', entry); self.assertNotIn('44444', self.runtime.config['TCP'])

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

    def test_stop_reason_is_recorded_only_when_it_can_be_shown(self):
        def stop_service_and_check(daemon=None, started_after_verify=None):
            entry = self.b.ledger['entries']['wks_test.preview']
            if daemon:
                self.runtime.daemon = daemon
                self.runtime.daemon_started = entry['verifiedAt'] + started_after_verify
            self.runtime.entry['lifecycle'] = 'stopped'
            self.b.reconcile()
            return self.b.ledger['entries']['wks_test.preview']
        self.b.handle(self.request())
        self.assertEqual(stop_service_and_check()['stopReason'], 'exited')
        self.b.handle(self.request())
        restarted = stop_service_and_check('boot:200:2', 5)
        self.assertEqual(restarted['stopReason'], 'daemon_restart')
        self.assertEqual(restarted['restartedAt'], self.runtime.daemon_started)
        # A stop that may have happened up to a minute before an unrelated restart, or
        # just beyond one broker cycle, cannot be tied to the restart.
        for gap in (60, RESTART_ATTRIBUTION_SECONDS + 1):
            self.b.handle(self.request())
            unexplained = stop_service_and_check(f'boot:{300 + gap}:3', gap)
            self.assertNotIn('stopReason', unexplained)
            self.assertNotIn('restartedAt', unexplained)
            self.assertEqual(unexplained['desired'], 'stopped')
        self.b.handle(self.request())
        self.b.handle(self.request('stop'))
        self.assertEqual(self.b.ledger['entries']['wks_test.preview']['stopReason'], 'stopped')

    def test_status_file_publishes_only_listed_fields(self):
        self.b.handle(self.request())
        self.b.reconcile()
        # A library error can echo its input; only fixed broker text or a type name leaves.
        self.b.ledger['entries']['legacy.preview'] = {'workspaceId': 'wks_old', 'service': 'web', 'frontend': 44445,
            'desired': 'stopped', 'status': 'failed', 'error': "invalid literal for int() with base 10: '/Users/x'"}
        self.b.publish_status()
        path = Path(self.c['channel']) / STATUS_FILE
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
        published = json.loads(path.read_text())
        service, legacy = published['services']
        self.assertEqual(legacy['error'], 'Error')
        self.assertIn('publishedAt', published)
        self.assertIn('checkedAt', service)
        self.assertLessEqual(set(service), set(STATUS_FIELDS))
        self.assertEqual((service['status'], service['frontend']), ('ready', 44444))
        entry = self.b.ledger['entries']['wks_test.preview']
        for private in ('cwd', 'terminal', 'listener', 'fingerprint', 'daemonWorker', 'url'):
            self.assertNotIn(private, service)
        self.assertNotIn(entry['cwd'], path.read_text())

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

    def test_relinked_survivor_keeps_its_preview_across_daemon_restart(self):
        # The new daemon re-linked the service whose terminal outlived the old one: same
        # terminal, same backend, same listener process. No start, and the link stays.
        self.c['restoreAfterRestart'] = True
        before = self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['status'], entry['desired'], entry['backend']), ('ready', 'running', before['backendPort']))
        self.assertEqual((self.runtime.starts, entry['daemon']), (0, 'boot:200:2'))
        self.assertIn('44444', self.runtime.config['TCP'])
        # The same terminal and backend under a different listener process is refused.
        self.runtime.daemon = 'boot:300:3'
        self.runtime.listener_identity = lambda port, terminal: 'another-process'
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['desired'], entry['stopReason'], self.runtime.starts), ('stopped', 'process_changed', 0))

    def test_unrecognized_running_service_after_daemon_restart_is_still_refused(self):
        # Another terminal running under the same name is not the verified one.
        self.c['restoreAfterRestart'] = True
        self.b.handle(self.request())
        self.runtime.daemon = 'boot:200:2'
        self.runtime.entry['terminalId'] = 'term-other'
        Broker(self.c, self.runtime).reconcile()
        entry = safe_read(self.b.ledger_path)['entries']['wks_test.preview']
        self.assertEqual((entry['desired'], entry['stopReason'], self.runtime.starts), ('stopped', 'process_changed', 0))
        self.assertNotIn('44444', self.runtime.config['TCP'])

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
