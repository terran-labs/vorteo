### Fixes

- Keep Codex app-server processes in the isolated local directory while passing workspace directories through the thread protocol. This prevents startup scans of shared project trees.

## Maintenance review

Removed the three session launch cwd overrides introduced by provider probe isolation. Non-custodial launches use the existing isolated process default; protected launch custody and thread workspace configuration remain unchanged. Archived history no longer needs its workspace directory for process startup. ACP session process cwd was not changed by the original probe patch and remains unchanged here. Added one focused process/thread cwd regression using a benign Node protocol fixture. The same correction restores custom-provider tests whose protocol workspace does not exist locally. Branch-name generation intentionally stays isolated; its test now verifies the fallback runner's probe cwd instead of a removed repository-cwd argument. README overview and onboarding are unchanged. Runtime delivery remains with Builds.
