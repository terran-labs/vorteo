#!/usr/bin/env python3
"""Run a dedicated Tailscale node for previews as a login agent.

Previews are agent-authored and belong on their own hostname, separate from the
interface. This installs a second Tailscale daemon in userspace networking mode, with its
own state and socket, so previews are published from a dedicated node. It needs no
administrator rights and does not touch the system Tailscale.

The operator supplies the standalone `tailscaled` and `tailscale` binaries (the macOS app
bundle does not ship them) and authorizes the new device once. Afterwards the preview
broker is pointed at the socket with install-native-https-broker.py --tailscale-socket.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

from https_broker import safe_dir
from launch_agent import install, label_for, owned_plist, remove

HOSTNAME = re.compile(r'^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')


def plan(deployment, tailscaled, hostname):
    """The login-agent definition and paths for one previews node. Pure, for tests."""
    if not HOSTNAME.fullmatch(hostname):
        raise ValueError('The node name must be a DNS label: lowercase letters, digits and hyphens')
    root = Path(deployment)
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('The previews node directory must be an absolute path')
    state = root / 'state'
    socket = root / 'tailscaled.sock'
    label = label_for('previews-node', root)
    return {
        'state': state, 'socket': socket, 'label': label,
        'content': {
            'Label': label,
            # Userspace networking: no tunnel device, no routes and no DNS changes on the
            # Mac. --port=0 lets the daemon pick its own UDP port beside the system one.
            'ProgramArguments': [str(tailscaled), '--tun=userspace-networking', '--statedir=' + str(state),
                                 '--socket=' + str(socket), '--port=0'],
            'RunAtLoad': True, 'KeepAlive': True, 'ProcessType': 'Background',
            'StandardOutPath': str(root / 'tailscaled.log'),
            'StandardErrorPath': str(root / 'tailscaled.log'),
            'EnvironmentVariables': {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin'},
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deployment', required=True, help='Directory that will hold the node state and socket')
    parser.add_argument('--tailscaled', required=True)
    parser.add_argument('--tailscale', required=True)
    parser.add_argument('--hostname', default='previews')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise ValueError('The dedicated previews node currently requires macOS')
    tailscaled = Path(args.tailscaled).resolve(strict=True)
    tailscale = Path(args.tailscale).resolve(strict=True)
    root = Path(args.deployment).absolute()
    node = plan(root, tailscaled, args.hostname)
    agents = Path.home() / 'Library/LaunchAgents'
    if args.uninstall:
        remove(node['label'], tailscaled, agents)
        print(json.dumps({'removed': node['label'], 'stateKept': str(node['state'])}))
        return
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.close(safe_dir(root))
    node['state'].mkdir(exist_ok=True, mode=0o700)
    owned_plist(node['label'], tailscaled, agents)
    install(node['content'], tailscaled, [])
    cli = [str(tailscale), '--socket=' + str(node['socket'])]
    for _ in range(40):
        if node['socket'].exists() and stat.S_ISSOCK(os.lstat(node['socket']).st_mode):
            break
        time.sleep(0.5)
    else:
        raise ValueError('The previews node did not start; read ' + str(root / 'tailscaled.log'))
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'TERM': 'dumb'}
    status = json.loads(subprocess.run([*cli, 'status', '--json'], capture_output=True, check=True, env=environment).stdout)
    result = {'label': node['label'], 'socket': str(node['socket']), 'state': status.get('BackendState')}
    if status.get('BackendState') == 'Running':
        result['hostname'] = status['Self']['DNSName'].rstrip('.')
    else:
        # Never accept DNS or routes from the tailnet: this node only serves previews.
        result['authorize'] = [*cli, 'up', '--hostname=' + args.hostname, '--accept-dns=false', '--accept-routes=false']
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
