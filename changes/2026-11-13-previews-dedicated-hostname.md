### Features

- Serve previews on a dedicated hostname. The native preview broker can publish through a second Tailscale node with its own state and socket, installed as a login agent, and the Previews comment frame and pairing page follow each reserved preview origin by name.

## Maintenance review

The broker gains an optional socket for the Tailscale daemon it publishes through, the native installer gains a guarded one-time move between nodes, and a new script runs the dedicated node. The Previews routes read the broker's reservations instead of assuming previews share the daemon's hostname. Broker tests cover the socket, the move guard and the node definition; Previews tests cover the allowed origins. The inventory gains a dedicated previews hostname entry. README overview and onboarding are unchanged.
