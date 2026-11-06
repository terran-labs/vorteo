### Added

- The installer engine's `coordinator-follow` command moves an installer-layout coordinator onto the release the Host runs, from a terminal on the Host, when its coordinator predates **Update the coordinator** in Installation controls. It refuses while restarts, maintenance preparation, coordinator requests, custom domain changes or lab and release upgrades are in flight, and checks again just before it moves the link. It announces the restart, restarts only the coordinator while running Host and Dev agents keep working, and rolls back unless a new, unfenced coordinator answers and is still up 15 seconds later. A closed terminal waits for the switch to finish. `--check` reports whether it can move without changing anything.

### Fixes

- The installer upgrade's coordinator step no longer accepts a fenced coordinator, or one that answers once and then crashes, as ready.
- **Update the coordinator** is unavailable when the coordinator service starts a fixed release instead of its release link, and fails, rather than reporting success, when the coordinator restarts on its previous release. It judges the release the coordinator started from, not where its link points now.

- A closed terminal during an installer service switch now exits only after the step is journaled, so a rerun never restarts that service a second time, and a coordinator that misses one stability probe gets two more tries before a rollback.

## Maintenance review

Added the owner-run coordinator follow to the installer engine, reusing the upgrade's coordinator step, lock and rollback, and guarded the in-app coordinator update against services pinned to a release. Owner-reviewed coordinator updates cannot move a coordinator that starts through its link, because they require canonical release paths and exact launcher arguments. Merged current `main`. README overview and onboarding are unchanged.
