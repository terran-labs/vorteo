### Fixes

- Restore the installer animation during Host and Dev release builds when updating an existing installation from the terminal.

## Maintenance review

The update build stages now use the existing installer animation. Terminal cleanup and plain redirected progress remain covered by the focused renderer tests. Installation behavior and README onboarding are unchanged.
