### Fixes

- A gate-mode Dev can read shared settings and launch installation profiles through its gate route. Settings and profile admission now accept `http://host.docker.internal:<listenPort>` only from a container client in gate mode, using the same rule as the managed Dev client; every other plain-HTTP origin outside Host loopback is still refused.

## Maintenance review

Settings and profile admission accept a gate-mode Dev's coordinator origin, which the managed Dev client already accepted, so a gate-mode Dev no longer fails its first settings read. One shared rule in `client-origin.ts` decides for all three: HTTPS, Host loopback, or `host.docker.internal` with a four- or five-digit port from a container client while `PASEO_NETWORK_MODE` is `gate`. The network gate entry is updated. Source only; not installed. README overview and onboarding are unchanged.
