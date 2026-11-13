### Fixes

- Switch the preview broker to another Tailscale node while holding the broker's lock, after verifying the old node against its pinned identity, and remove reservations that name the old hostname.
- Allow the Previews comment frame and pairing page to follow only the exact origins the broker reserved, with no hostname-wide allowance.
- Refuse a previews node directory, state directory or socket that is not owned by the current user and private.

## Maintenance review

Review corrections to the unreleased dedicated previews hostname. The installer's check and commit are one locked step, tested with a start that lands between an earlier look and the switch. The origin policy no longer accepts any port on the daemon's hostname. The node and broker installers validate ownership and mode of existing directories and the socket. Uninstalling the node no longer needs the binaries to exist. README overview and onboarding are unchanged.
