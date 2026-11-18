"""Tailnet access scope: the grants a pinned packet filter allows, and how they changed.

Shared by the native and container broker installers, which re-pin a reviewed scope
change on the same node only when the administrator asks for it.
"""
import json


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
