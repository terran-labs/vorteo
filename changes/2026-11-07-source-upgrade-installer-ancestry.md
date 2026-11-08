### Fixes

- The installer refuses to upgrade to a release that does not contain a commit a source upgrade installed, instead of silently dropping it.

## Maintenance review

Completes the release-ancestry guard for source upgrades in the installer and adds a test of the interface release upgrade's matching refusal. The installation guide section was revised; the inventory entry still describes the feature accurately. README overview and onboarding are unchanged.
