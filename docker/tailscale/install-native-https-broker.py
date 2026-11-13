#!/usr/bin/env python3
"""Install a native preview consumer without changing either agent daemon."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import stat
import shlex
import sys
import time

from channel_identity import broker_lock
from https_broker import NativeRuntime, atomic, digest, private_directory, safe_dir, safe_read
from launch_agent import install, label_for, owned_plist


def prepare_deployment(path):
    """Create the broker's directory, or accept an existing one only if it is private.

    The broker's scripts, pins and lock live here and run with this user's authority.
    """
    root = Path(path).absolute()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.close(safe_dir(root))
    private_directory(root)
    return root


def private_socket(path):
    """A daemon socket this user owns, inside a directory only this user can enter."""
    path = Path(path)
    info = os.lstat(path)
    parent = os.lstat(path.parent)
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('The previews node socket is not a socket owned by this user')
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('The previews node socket must sit in a private directory')


NODE_FIELDS = ('tailscale', 'tailscaleSocket', 'nodeId', 'hostname', 'packetFilterHash')


def check_identity(previous, config, ledger, move, previous_publication):
    """Refuse an install that would change what an existing broker is pinned to.

    The node a broker publishes through may change only on an explicit move, and only when
    nothing is published: every preview stopped, and no mapping the ledger owns left on the
    old node. Otherwise a running preview's link would change hostname underneath it.
    """
    for field in ('runtime', 'daemonHome', 'cliCommand', 'channel', 'workspacePolicy', 'allowedRoots'):
        if field in previous and previous[field] != config[field]:
            raise ValueError('Existing native broker identity or policy differs: ' + field)
    changed = [field for field in NODE_FIELDS if previous and previous.get(field) != config.get(field)]
    if not changed:
        return
    if not move:
        raise ValueError('Existing native broker identity or policy differs: ' + changed[0])
    entries = list(ledger.get('entries', {}).values())
    if any(entry.get('desired') == 'running' for entry in entries):
        raise ValueError('Stop every preview before moving the broker to another node')
    published = previous_publication()
    owned = {str(entry['frontend']) for entry in entries if 'frontend' in entry}
    if owned & set(published.get('TCP', {})):
        raise ValueError('The old node still publishes a preview port; remove it before moving')


@contextmanager
def waiting_broker_lock(root, seconds=120):
    """The broker's own lock, waited for. A broker run holds it for under a minute."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            with broker_lock(root) as check:
                yield check
                return
        except BlockingIOError:
            if time.monotonic() > deadline:
                raise ValueError('The preview broker is busy; try the install again') from None
            time.sleep(0.5)


def switch_pins(root, channel, config, move, replace_files, runtime_for=NativeRuntime, wait=120):
    """Check what the broker is pinned to and commit the new pins, as one step.

    The broker publishes under this same lock. Holding it from reading the prior config and
    ledger until the new config is written means a queued start cannot be published on the
    old node after the check and then be orphaned by the switch. The old node is verified
    with its own pinned identity before its publication is trusted.
    """
    with waiting_broker_lock(root, wait):
        config_path = root / 'host-config.json'
        previous = safe_read(config_path) if config_path.exists() else {}
        ledger_path = root / 'https-broker-ledger.json'
        ledger = safe_read(ledger_path, 2 * 1024 * 1024) if ledger_path.exists() else {}

        def previous_publication():
            runtime = runtime_for(previous)
            runtime.preflight()
            return runtime.publication()

        check_identity(previous, config, ledger, move, previous_publication)
        moving = bool(previous) and any(previous.get(field) != config.get(field) for field in NODE_FIELDS)
        replace_files()
        if moving:
            # Reserved origins name the old hostname. Remove them so nothing treats an
            # old-host origin as a current preview; each start writes its origin again.
            for origin in (Path(channel) / 'origins').glob('*.json'):
                origin.unlink()
        atomic(config_path, config)
    return previous


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deployment', required=True)
    parser.add_argument('--daemon-home', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--cli-entry', required=True)
    parser.add_argument('--tailscale', required=True)
    # A dedicated previews node: the socket of a second Tailscale daemon that owns the
    # preview hostname. --tailscale must then be a CLI that can address that daemon.
    parser.add_argument('--tailscale-socket')
    # Required once to move an existing broker to another node. Refused while any
    # preview is running, because its link would silently change hostname.
    parser.add_argument('--move-previews-node', action='store_true')
    parser.add_argument('--workspace-policy', choices=['registered', 'approved-roots'], default='registered')
    parser.add_argument('--allowed-root', action='append', default=[])
    parser.add_argument('--restore-after-restart', action=argparse.BooleanOptionalAction, default=False)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise ValueError('Native previews currently require macOS')
    root = prepare_deployment(args.deployment)
    home = Path(args.daemon_home).absolute()
    os.close(safe_dir(home))
    node = str(Path(args.node).resolve(strict=True))
    cli = str(Path(args.cli_entry).resolve(strict=True))
    tailscale = str(Path(args.tailscale).resolve(strict=True))
    socket = None
    if args.tailscale_socket:
        socket = Path(args.tailscale_socket).absolute()
        private_socket(socket)
        socket = str(socket)
    bin_dir = Path.home() / '.local/bin'
    launcher = bin_dir / 'paseo-preview'
    ownership = '# Native preview broker: ' + str(root)
    if launcher.is_symlink() or (launcher.exists() and ownership not in launcher.read_text().splitlines()):
        raise ValueError('Existing preview command belongs to another installation')
    channel = Path.home() / '.local/share/paseo-preview/https'
    label = label_for('https-preview-broker', root)
    owned_plist(label, root / 'https_broker.py', Path.home() / 'Library/LaunchAgents')
    config = {
        'runtime': 'native', 'deployment': str(root), 'daemonHome': str(home),
        'cliCommand': [node, cli], 'tailscale': tailscale, 'channel': str(channel),
        'brokerLabel': label, 'workspacePolicy': args.workspace_policy,
        'allowedRoots': args.allowed_root, 'approvedWorkspaces': {},
        'reservedPorts': [443, 6767, 6768, 6770, 6771, 44443],
        'portStart': 32768, 'portEnd': 60999,
        'restoreAfterRestart': args.restore_after_restart,
    }
    if socket:
        config['tailscaleSocket'] = socket
    if args.workspace_policy == 'approved-roots' and not args.allowed_root:
        raise ValueError('Approved-roots policy requires at least one allowed root')
    runtime = NativeRuntime(config)
    workspaces = runtime.cli(['workspace', 'ls'])
    # Native tasks share the user's authority. This is source separation, not a
    # sandbox boundary. A home-directory workspace must not prohibit installing
    # user tools under that same home; specific project roots remain excluded.
    for workspace in workspaces:
        cwd = Path(workspace['cwd']).resolve()
        if root == cwd or (cwd != Path.home() and cwd in root.parents):
            raise ValueError('Install broker outside registered workspace directories')
    runtime.daemon_identity()
    status = json.loads(runtime.ts(['status', '--json']))
    config.update(hostname=status['Self']['DNSName'].rstrip('.'), nodeId=status['Self']['ID'])
    netmap = json.loads(runtime.ts(['debug', 'netmap']))
    config['packetFilterHash'] = digest(netmap.get('PacketFilter'))
    if not any(destination['Ports']['First'] <= config['portStart'] and destination['Ports']['Last'] >= config['portEnd']
               for rule in netmap.get('PacketFilter', []) for destination in rule.get('Dsts', [])):
        raise ValueError('Existing tailnet policy does not cover preview ports; no grants changed')
    runtime.publication()
    if (channel / 'installed.json').exists():
        marker = safe_read(channel / 'installed.json')
        if marker.get('deployment') != str(root):
            raise ValueError('Preview channel already belongs to another broker')
    for name in ('', 'inbox', 'receipts', 'origins'):
        directory = channel / name
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.close(safe_dir(directory))
    config['channelIdentities'] = {name: [os.stat(channel / name).st_dev, os.stat(channel / name).st_ino]
                                   for name in ('', 'inbox', 'receipts', 'origins')}
    source = Path(__file__).resolve().parent
    names = ['https_broker.py', 'channel_identity.py', 'host_config.py', 'launch_agent.py', 'https-preview.py',
             'uninstall-https-broker.py', 'paseo-preview.mjs', 'preview-broker-client.mjs']
    backup = root / 'backups' / str(time.time_ns())

    def replace_files():
        backup.mkdir(parents=True, mode=0o700)
        for name in [*names, 'host-config.json']:
            if (root / name).exists():
                shutil.copy2(root / name, backup / name)
        for name in names:
            temporary = root / (name + '.install')
            shutil.copyfile(source / name, temporary)
            temporary.chmod(0o700)
            os.replace(temporary, root / name)

    switch_pins(root, channel, config, args.move_previews_node, replace_files)
    helper = [node, str(root / 'paseo-preview.mjs')]
    bin_dir.mkdir(parents=True, exist_ok=True)
    if launcher.exists():
        shutil.copy2(launcher, backup / 'paseo-preview')
    temporary = bin_dir / 'paseo-preview.install'
    temporary.write_text('#!/bin/sh\n' + ownership + '\nexec ' + shlex.join(helper) + ' "$@"\n')
    temporary.chmod(0o700)
    os.replace(temporary, launcher)
    instructions = Path.home() / '.config/paseo-preview/AGENTS.md'
    instructions.parent.mkdir(parents=True, exist_ok=True)
    if instructions.exists():
        shutil.copy2(instructions, backup / 'AGENTS.md')
    shutil.copyfile(source / 'AGENT-INSTRUCTIONS.md', instructions)
    atomic(channel / 'installed.json', {'version': 1, 'deployment': str(root),
           'cliCommand': config['cliCommand'], 'daemonHome': str(home), 'helperCommand': helper})
    (channel / 'disabled.json').unlink(missing_ok=True)
    content = {
        'Label': label, 'ProgramArguments': [str(Path(sys.executable).resolve()), '-I', str(root / 'https_broker.py')],
        'RunAtLoad': True, 'StartInterval': 10, 'ProcessType': 'Background', 'LowPriorityIO': True,
        'StandardOutPath': str(root / 'https-broker.stdout.log'),
        'StandardErrorPath': str(root / 'https-broker.stderr.log'),
        'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/local/bin'},
    }
    install(content, root / 'https_broker.py', [])
    print(json.dumps({'installed': str(root), 'helperCommand': helper, 'backup': str(backup),
                      'label': label, 'daemonRestarted': False}))


if __name__ == '__main__':
    main()
