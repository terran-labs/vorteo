### Changes

- Factory can pick a quota-aware account for an agent that will start on a connected host such as Dev: `vorteo factory project pick-account --server <server-id>` returns that host's own id for the same installation account, so work never starts on an account the host lacks or excludes. An unreadable host fails the pick instead of falling back, and a stage profile bound to one account is refused for another host because it cannot launch there.

## Maintenance review

Added an optional `serverId` to the Factory pick-account input, output and stored picks, plus an optional `localProvider` on considered accounts; all new fields are optional and the CLI sends `serverId` only when given, telling the operator to update an older daemon that refuses it. The daemon reads the destination's settings and provider list through connected hosts and ranks with its own usage readings; avoiding an account by either host's id avoids every local alias of it. The Foreman charter does not pass `--server` yet. README overview and onboarding are unchanged. Not installed.
