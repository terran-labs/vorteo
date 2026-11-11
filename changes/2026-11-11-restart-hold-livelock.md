### Fixes

- Updates that wait for current work no longer stall for hours. An agent waiting on another agent's reply now receives it inside its running turn, so it can finish, and held messages wait for the update instead of retrying every few seconds.
- After 15 minutes of waiting, the update asks you to restart now or cancel, and it lists the agents it is waiting for. Restart now is available for source updates too.

### Maintenance

- The daemon keeps ten rotated log files instead of three, and logs which agents a waiting restart is holding for.

## Maintenance review

Restart holds steer messages into running turns, wait for release instead of retrying, and ask the owner after a configurable deadline. Restart activity lists holders and offers Force restart now for updates and batches. Daemon log retention rises to ten files. README overview and onboarding are unchanged.
