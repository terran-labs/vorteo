### Fixes

- Check release identity and installed source containment before taking upgrade snapshots, so refused updates do not consume backup space or evict rollback points. Repeat checks after backup and retain source updater validation before installation.
- Apply the same tree-containment rule to installer and tracked Host release prechecks, allowing local integration histories whose changes are already present in the release.

## Maintenance review

Reviewed upgrade sequencing, source-upgrade history and snapshot retention. Release prechecks do not stage updates or change installed state; snapshot protection remains ahead of Host builds and restarts. README overview and onboarding are unchanged.
