### Fixes

- Host release cleanup keeps the releases the served interface, Chrome native host wrappers, LaunchAgents and recent release links use, puts back releases a dead cleanup left set aside, and never deletes through a folder swapped for a link.

## Maintenance review

Second review round on safe release pruning. References now include `sourceUpdates.webDirectory` and `webDistDir`, job folders named in `claude-accounts/*/chrome/chrome-native-host` wrappers and in every `~/Library/LaunchAgents` property list (contents are only searched, never logged), and the last five distinct targets of the Host and coordinator release links, kept in a history file and listed in the cleanup receipt. A restore pass puts back every `.pruning-<id>` whose own name is free at coordinator start, before each cleanup and when the in-use read fails. Removal of a `.deleting-<id>` folder requires a real directory at its own canonical path before listing and before each child. "Newest" uses the lifecycle job's start time, falling back to folder time, and `hostReleaseKeepNewest` in the coordinator configuration sets the count (default 3). Tests cover each change; disabling the restore passes or the per-child confinement check fails them. Documented in the installation reference and inventory. README overview and onboarding are unchanged. Not installed.
