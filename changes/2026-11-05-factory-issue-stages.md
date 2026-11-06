### Features

- Add Factory issue planning and supervision with a configurable planner profile and a planning switch, plus a cached issue queue showing stages, pull request checks and participating agents. The Foreman assigns one lead per issue, routes repairs through it and records independent review results against the exact PR head. Planning off preserves the existing worker and reviewer flow. Paused leads and workers are exempt from stall recovery, and drains count mid-turn leads as well as workers. Queue comments must come from the authenticated GitHub viewer, CLI errors show the underlying diagnostic, and older daemons do not display unsupported planning settings.

### Maintenance

- Merged current `main` via the Factory drain branch into the issue stages branch.

## Maintenance review

Factory issues gain an optional Plan stage with one lead supervising the worker. Planner profile and planning settings are configurable through the project RPC and CLI; old state files read without a rewrite. The queue RPC caches GitHub evidence for 30 seconds, reports failures and shows issue stages, PR checks and labeled agents in role workspaces. Foreman records independent review results for display, accepted only from the authenticated GitHub viewer; merge approval requires the independent reviewer's own exact-head reply. Paused leads and workers are exempt from stall handling, and drain counts include mid-turn leads. CLI errors preserve the underlying diagnostic and older daemons omit unsupported planning settings. Source only, not installed. README overview and onboarding are unchanged.
Merged current `main` via the Factory drain branch; no source conflicts.
