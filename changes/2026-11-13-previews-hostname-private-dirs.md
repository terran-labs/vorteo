### Fixes

- Refuse a preview broker directory that is not owned by the current user with mode 0700, before writing files or taking the lock.
- Recognize the previews node's login agent by the canonical path of its binary, so removal works when the binary was given through a link.

## Maintenance review

Final review items on the unreleased dedicated previews hostname. The private directory rule moved into the broker module and now guards the broker deployment directory as well as the node's. Tests cover a world-writable existing directory and a linked binary path at install and removal. README overview and onboarding are unchanged.
