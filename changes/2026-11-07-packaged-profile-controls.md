### Fixed

- Restore cross-environment model compatibility warnings in the routed profile editor. Saved aliases remain unchanged, and unsupported or unavailable environment catalogs retain their existing warnings.

### Maintenance

- Update five packaged installation test groups to use provider Settings and inline draft profiles, and read project identity before opening the handoff sheet. Preserve compatibility, shared edits, environment exclusions, draft attachments and workspace membership checks.
- Apply and verify the fixture's final shared settings revision before starting background reconciliation and agent launches.

## Maintenance review

The routed editor now displays the compatibility hints already computed by its form model. Packaged coverage uses isolated fake catalogs, current page controls and distinct default profiles so ignored profile clicks fail through their resulting agent configuration or intercepted public launch request. README overview and onboarding are unchanged.
