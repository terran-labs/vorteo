### Features

- The sidebar adds an All Factories card above Pinned whenever a Factory is on or paused. It sums every project's Factory in the same form as a project card: a combined state, a Needs you count, a merged stage bar, one chip per Factory that opens its overview, and every runner tagged with its project. Click the card to open the All Factories overview. Collapse it from its icon; it is remembered on this device.

### Fixes

- Sidebar Factory cards read the issue queue only while expanded on a running Factory, every two minutes, instead of every 30 to 60 seconds. Each read is a GitHub read on the Foreman's account; collapsed and paused cards show the last queue they read.

## Maintenance review

Added the All Factories card inventory entry and noted the slower queue reads that project cards now share. Interface only; no server, protocol or plugin changes. The All Factories overview page comes from a separate change. Checked in the isolated browser demo, dark and light, with temporary sample data that is not committed. Source only; not installed. README overview and onboarding are unchanged.
