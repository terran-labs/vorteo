### Added

- Installation controls offer to update the installation coordinator when it runs an older release than the Host, as happens after Host source updates on an installation that follows `main`. The owner approves the exact Host release; the coordinator restarts on it and rolls back automatically if it does not answer within two minutes. Agents keep running and see the offer read-only in `update-status`.

## Maintenance review

Added the owner-approved coordinator update for installations in the installer layout, the supported way to move their coordinator onto a Host source update's release, reusing the release upgrade's coordinator swap. Merged current `main`. README overview and onboarding are unchanged.
