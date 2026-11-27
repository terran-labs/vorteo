### Fixes

- Factory issue workspaces, including those in Dev, now list under the Factory that owns their issue instead of in the project's ordinary list. A running issue's Runners row opens its workspace, and issue workspaces with nothing running sit in a folded Idle group (#683).
- A Factory issue workspace whose worker finished no longer shows the green "finished, unread" dot, which read as running; it shows the neutral state. Green keeps its meaning everywhere else (#683).

## Maintenance review

Interface only. A workspace counts as a Factory issue workspace when every unarchived agent in it carries `factory.issue`; its `factory.installation` label names the owning Factory, which may be on another host. The workspace agent activity index carries that marker, the sidebar entry exposes it, and the Factory grouping and cards route by it. Updated the "Factory sidebar sections" inventory entry. One case added to the existing sidebar view model test. Known limit: a workspace whose agents are all archived has no labels the app can see, so it stays in the ordinary list. README overview and onboarding are unchanged.
