### Fixes

- Refuse daemon origin admission against the implicit managed Host while preserving origin inspection.

## Maintenance review

Added the origin mutation route to the existing installer guard and temporary fake-CLI test. Earlier guard behavior and explicit targets remain unchanged. The inventory records the distinction; README onboarding is unaffected.
