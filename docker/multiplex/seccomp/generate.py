"""Generate the Dev policy from the pinned upstream policy and reviewed exceptions."""
import argparse
import hashlib
import json
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
UPSTREAM_COMMIT = '836ae4d37ef2ec995c77c99fc55f5b5f3af3a897'
UPSTREAM_SHA256 = '536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74'

# Removal probes require these five bubblewrap exceptions; chroot is required by #284.
# Changing this list is a runtime security-policy change, including on new installs.
APPROVED_EXCEPTIONS = (
    ('clone', 'Bubblewrap creates child processes in its private namespaces.'),
    ('unshare', 'Bubblewrap creates an unprivileged user namespace before setting up its private mount tree.'),
    ('mount', 'Bubblewrap constructs its private mount tree inside its user namespace.'),
    ('umount2', 'Bubblewrap detaches mounts from its private mount tree.'),
    ('pivot_root', 'Bubblewrap switches to the root of its private mount tree.'),
    ('chroot', 'Chromium seals its sandbox using chroot inside its unprivileged user namespace (#284).'),
)


def generate_profile():
    upstream = (SOURCE / 'upstream-default.json').read_bytes()
    if hashlib.sha256(upstream).hexdigest() != UPSTREAM_SHA256:
        raise ValueError('Pinned upstream seccomp policy checksum mismatch')
    profile = json.loads(upstream)
    profile['syscalls'].extend(
        {'names': [name], 'action': 'SCMP_ACT_ALLOW', 'comment': reason}
        for name, reason in APPROVED_EXCEPTIONS
    )
    return profile


def verify_profile(profile):
    if profile != generate_profile():
        raise ValueError('Dev seccomp policy differs from pinned upstream plus approved exceptions')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    output = SOURCE.parent / 'dev-seccomp.json'
    if args.check:
        verify_profile(json.loads(output.read_text()))
    else:
        output.write_text(json.dumps(generate_profile(), indent=2) + '\n')


if __name__ == '__main__':
    main()
