### Features

- Installation controls show Stable source upgrades under **Source upgrades**, with when a delegated one starts, and Install, Reject and Cancel. An open page checks for new delegated requests every ten seconds, well inside their thirty-second window.
- Builds can request a Stable source upgrade with `request-source-upgrade` and follow it with `source-upgrade-status`. Under full maintenance delegation it starts after a thirty-second window, finishing current turns before the Host restarts; otherwise the owner approves it. Rollbacks stay with the owner.

### Maintenance

- Every owner route now has an agent request command, an exclusion or a pinned exemption; the front-door gap list is empty.

## Maintenance review

Added a Host-agent source upgrade request whose delegated approval is kept beside the strict upgrade journal. Admission runs again while the record is pending, then one write moves it straight to running, so a rolled-back coordinator never finds an approved record to replay. A lapsed grant returns the request to the owner, and owner decisions clear the evidence. The status shows when a delegated request starts and that current work finishes first, projected from that evidence while the grant holds, without changing the record. Not yet installed. README overview and onboarding are unchanged.
