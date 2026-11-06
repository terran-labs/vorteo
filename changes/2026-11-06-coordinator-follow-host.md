### Added

- Installation controls offer to update the installation coordinator when it runs an older release than the Host, as happens after Host source updates on an installation that follows `main`. The owner approves the exact Host release; the coordinator restarts on it and rolls back automatically if it does not answer within two minutes. Agents keep running and see the offer read-only in `update-status`.

### Fixes

- Host source updates no longer prune the release an installer-layout coordinator runs through its own link, which would have left its next start nothing to run or roll back to.

## Maintenance review

Added the owner-approved coordinator update for installations in the installer layout, the supported way to move their coordinator onto a Host source update's release, reusing the release upgrade's coordinator swap. A finished attempt never hides a new offer, the card names the release it moves to, and the update waits for approved Host restarts and open coordinator requests. Merged current `main`. README overview and onboarding are unchanged.
