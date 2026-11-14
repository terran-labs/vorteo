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


def stable_path(value):
    """An existing file's absolute path, kept exactly as the administrator wrote it.

    The daemon CLI is reached through a link that an update repoints to the new release.
    Resolving it would pin one release: the pin would stop matching on the next reinstall
    and the broker would keep running a CLI that an update has left behind.
    """
    path = Path(value)
    if not path.is_absolute() or path != Path(os.path.normpath(path)):
        raise ValueError('The CLI entry must be a normalized absolute path')
    if not path.is_file():
        raise ValueError(f'{path} is not a file')
    return str(path)


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


def access_scope(packet_filter):
    """What the pinned hash covers, as one record per grant, in a form a person can read.

    A grant is one source reaching one destination, with its ports, protocols and any other
    field of the rule that affects permission. Keeping the pairing matters: two rules can
    swap what each source may reach while the sets of sources and destinations stay the
    same. The filter lists every device address allowed to reach this node, so it changes
    whenever a device joins or leaves the tailnet, not only when the policy is edited.
    """
    grants = set()
    for rule in packet_filter or []:
        # Everything in the rule except who and where, so no permission-relevant field is dropped.
        other = json.dumps({key: value for key, value in rule.items() if key not in ('Srcs', 'Dsts', 'IPProto')},
                           sort_keys=True, separators=(',', ':'))
        protocols = ','.join(str(protocol) for protocol in sorted(rule.get('IPProto') or [])) or 'default'
        destinations = [(str(d.get('Net')), f"{(d.get('Ports') or {}).get('First')}-{(d.get('Ports') or {}).get('Last')}")
                        for d in rule.get('Dsts') or []] or [('', '')]
        for source in rule.get('Srcs') or ['']:
            for net, ports in destinations:
                grants.add(json.dumps({'source': str(source), 'destination': net, 'ports': ports,
                                       'protocols': protocols, 'other': other}, sort_keys=True))
    return {'grants': sorted(grants)}


def device_names(status):
    """Device name for each tailnet address in `tailscale status --json`, without the mask."""
    names = {}
    for device in [status.get('Self') or {}, *(status.get('Peer') or {}).values()]:
        name = (device.get('DNSName') or '').split('.')[0] or device.get('HostName') or ''
        for address in device.get('TailscaleIPs') or []:
            names[address] = name
    return names


def scope_change(previous, config, names=None, packet_filter=None):
    """Summary of an access scope about to be accepted in place of the pinned one.

    Reports grants added and removed, each with device names where the tailnet knows them,
    because an administrator can judge "the previews node may reach every port" and cannot
    judge a bare address. When the hash changed but no grant did, or there is no earlier
    record to compare with, it says so and shows the raw rules instead of implying that
    nothing changed.
    """
    names = names or {}

    def described(grants):
        result = []
        for grant in map(json.loads, grants):
            name = lambda address: names.get(address.split('/')[0]) or 'unknown device'
            result.append({**grant, 'sourceDevice': name(grant['source']), 'destinationDevice': name(grant['destination'])})
        return result

    before = (previous.get('accessScope') or {}).get('grants')
    after = config['accessScope']['grants']
    change = {'grants': len(after)}
    if before is None:
        # Installs before this record kept only the hash, so there is nothing to compare.
        change['comparison'] = 'no earlier record; every current grant is listed'
        change['allGrants'] = described(after)
        return change
    change['addedGrants'] = described(sorted(set(after) - set(before)))
    change['removedGrants'] = described(sorted(set(before) - set(after)))
    if not change['addedGrants'] and not change['removedGrants']:
        change['comparison'] = 'rule change not represented as a grant difference; raw rules follow'
        change['rawRules'] = packet_filter
    return change


def check_identity(previous, config, ledger, move, previous_publication, accept_scope=False):
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
    # The same node with a different access scope: accepted only when the administrator
    # asks for it, after reading the summary the installer prints.
    if changed == ['packetFilterHash'] and accept_scope:
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


def switch_pins(root, channel, config, move, replace_files, runtime_for=NativeRuntime, wait=120,
                accept_scope=False):
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
            # Leaving a node safely needs proof that it is the same node and what it
            # still publishes. Its access scope no longer matters once it is not used, and
            # adding the new node to the tailnet has usually changed it already.
            runtime.verify_node()
            return runtime.publication()

        check_identity(previous, config, ledger, move, previous_publication, accept_scope)
        # A different access scope on the same node is not a move: its reserved origins
        # are still correct, and running previews keep relying on them.
        moving = bool(previous) and any(previous.get(field) != config.get(field)
                                        for field in NODE_FIELDS if field != 'packetFilterHash')
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
    # Re-pin the access scope of the SAME node after a reviewed tailnet change, such as a
    # device joining or leaving. The installer prints what it accepted.
    parser.add_argument('--accept-access-scope', action='store_true')
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
    cli = stable_path(args.cli_entry)
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
    config['accessScope'] = access_scope(netmap.get('PacketFilter'))
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

    previous = switch_pins(root, channel, config, args.move_previews_node, replace_files,
                           accept_scope=args.accept_access_scope)
    accepted = (scope_change(previous, config, device_names(status), netmap.get('PacketFilter'))
                if previous and previous.get('packetFilterHash') != config['packetFilterHash'] else None)
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
                      'label': label, 'daemonRestarted': False,
                      **({'acceptedAccessScope': accepted} if accepted else {})}))


if __name__ == '__main__':
    main()
