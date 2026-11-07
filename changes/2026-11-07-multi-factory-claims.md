### Features

- Several Vorteo installations can run Factory on the same GitHub repository. The Foreman claims each issue by creating `factory/issue-<n>` on GitHub, so exactly one installation works on it, and never touches another installation's claim. A claim idle for more than a day is raised to the owner once and released only with their yes, with its commits kept.
- `.github/factory.json` names the one installation that runs Triage and the one that runs Releases for a repository. The Factory Overview shows the assignment and flags a role that is off here.
- `paseo factory project claim issue` and `paseo factory project claim release` expose claims; `paseo factory project show` prints the installation name and role assignment.

### Fixes

- Turning on Factory refuses a repository that another project on the same installation already runs.
- `vorteo-release.mjs tag` recovers when another installation creates the same release tag first: the same commit counts as done, and another commit names the next version to prepare. Tags are never moved or reused.

## Maintenance review

Multi-installation Factory: daemon claims with intent recovery, foreign-claim protection, stale-claim release through an archive ref, `.github/factory.json` role gating, a duplicate-repository guard, Overview role assignment and release tag collision recovery. The shipped Foreman, Triage and Releases charters and the shared rules change, so every role's charter review fires after install. The task worktree helper accepts `factory/` branches. Wire changes add optional fields and two new RPCs only. Source only; not installed. README overview and onboarding are unchanged.
