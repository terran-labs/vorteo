### Features

- Add `paseo factory project list`, `pause-all` and `resume-all` for draining Factory work before a restart or upgrade. Pause-all pauses every project whose Factory is on and records each drain with its own id, reason and time; resume-all resumes only those, so projects an operator paused by hand stay paused. A manual pause, resume or turn off takes a project out of the drain, and the record survives a daemon restart.
- Pause-all sends each paused project's Foreman one drain notice carrying the drain id, steered into its current turn, and clears its status line; the Foreman acknowledges with "Drained <id>: <n> workers still finishing", so an earlier drain's reply cannot satisfy a new one. Resume-all tells it the drain ended. A failed notice is retried by the next pause-all, notices skip archived or missing projects until they are restored, and a drain recorded before ids existed gets a new notice with its id.

### Changes

- A damaged Factory state file makes list, pause-all and resume-all refuse instead of reporting an empty or successful drain.
- Charters: the Mechanic reads `installation-agent.mjs update-status` and copes while it does not exist yet; Builds drains with pause-all and waits for the Foreman's acknowledgment, orders lifecycle actions, keeps release notes append-only and proposes restoring the pre-install snapshot on a regression; the Foreman checks the drain before every admission and cancels superseded CI runs; and every role gains the operating rules Builds learned running delivery.

### Maintenance

- Merged current `main`, including release 26.11.500, into the Factory drain and update duties branch; both sides' entries are kept.
- Merged current `main` into the Factory drain and update duties branch; both sides' entries are kept.

## Maintenance review

Factory drains for updates. `paseo factory project list`, `pause-all` and `resume-all` pause every active project's Factory before a restart or upgrade and resume only what they paused; each drain has an id that the Foreman's drain notice and its "Drained <id>" acknowledgment carry, and a damaged state file refuses instead of reporting success. The Mechanic charter reads update status and the Builds charter drains before restarts; every role gains the operating rules Builds learned running delivery. This source is not installed. README overview and onboarding are unchanged.
