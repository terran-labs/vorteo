### Fixes

- When the installer refuses a release that would drop a commit a source upgrade installed, it now advises fixing forward on main and source-upgrading again, keeping snapshot restores for damaged state.
- When the installer will not take over a source upgrade, it says why, such as a Host build still running, and how to clear it.
- A `--source` checkout that lacks the installed commit now gets a clear error suggesting a fetch of main, instead of a false report that the release drops the commit.

## Maintenance review

Builds asked for this follow-up to the Stable source upgrade wording on 2026-11-07; the helper that received it ended without committing, so it is redone here from main. Behavior is unchanged except the new missing-commit check, which previously fell through to `merge-base` and was misreported as the target dropping the commit. Existing installer test tables gain one row or assertion per message. The installation reference is updated; the customizations inventory and README need no change.
