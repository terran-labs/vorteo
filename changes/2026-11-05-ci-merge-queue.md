### Maintenance

- Pull requests run only the required checks (`changes`, `format`, `lint`, `typecheck`, `scan`) and cheap Ubuntu suites: `quality`, server unit tests, `app-tests` and a new `cli-unit` job. Playwright, the Windows and macOS jobs, desktop, installer and CLI E2E run on merge groups, manual runs, a nightly schedule and `release-*` tags. Container and Desktop Packages left pull requests and run after merge or on demand. The secret scan now runs on merge groups.
- The checked-in `main` ruleset adds a merge queue that merges with merge commits and drops the up-to-date branch requirement. It is not applied to GitHub yet.
- The publisher no longer refuses a branch because `main` moved. It refuses only a pull request GitHub reports as conflicting, merges pinned to the tested head through the queue, and waits until GitHub reports it merged. Release preparations no longer need re-preparing when `main` moves.
- Commits add a change fragment, `changes/YYYY-MM-DD-<slug>.md`, instead of editing the top of `VORTEO_CHANGELOG.md` and the inventory. The commit hook validates fragments, release preparation folds them into the new version's entry and the inventory, and `live-dev commit` writes one.

## Maintenance review

CI routing, merge queue ruleset, conflict-only publisher refusal and change fragments. Task delivery scripts updated in the inventory. Source only; the ruleset is not applied and nothing is installed. README overview and onboarding are unchanged.
