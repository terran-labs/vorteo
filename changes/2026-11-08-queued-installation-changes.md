### Features

- Builds can request an installation rename, a delivery mode or installation type change, ordinary settings changes and a custom domain change with `request-installation-change`. Each appears in **Requested installation changes** in Installation controls with what it disrupts, and the owner can apply or cancel it; under full maintenance delegation it starts after a thirty-second window.
- A custom domain change checks the main address and the new domain's certificate first, and restores the previous domain automatically if either address stops answering afterwards.

### Maintenance

- The front-door test pins each queued installation change to the owner operation its route performs.

## Maintenance review

Added a queue for five reviewed installation changes, each a fixed definition that calls the same operation as its owner route, with delegated admission, dispatch-time grant checks, the replaced value recorded before any effect, and reachability verification with automatic restore for the custom domain and delivery mode. Success requires the requested value in effect, a restore is durable, runs at most once and refuses to overwrite a newer owner change, and the card shows the exact requested values. Ordinary settings exclude every guardrail and credential field. Stable source upgrades remain pinned gaps for a following change. Not yet installed. README overview and onboarding are unchanged.
