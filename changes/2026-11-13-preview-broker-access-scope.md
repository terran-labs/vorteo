### Fixes

- Let the preview broker move to a dedicated node after that node has joined the tailnet. The move verifies the old node's identity and that it publishes none of the broker's ports, and no longer requires its access scope to be unchanged.
- Add a reviewed way to accept a changed tailnet access scope on the same node: `--accept-access-scope` on the native broker installer prints the added and removed sources with their device names before the broker runs again.

## Maintenance review

Correction to the dedicated previews hostname, found on the owner's installation: a device joining the tailnet changed the pinned packet filter hash, the broker refused every operation, and no supported re-pin existed. The installer now records the readable access scope beside the hash so later changes can be shown as a difference. The guide explains why the hash changes and both ways to recover. Whether the hash should exclude device addresses is left as an open design question. README overview and onboarding are unchanged.
