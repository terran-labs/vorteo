### Fixes

- Restore Dev's Force restart escape hatch alongside Host after the existing one-minute approval guard. Keep source updates and exact-plan operations behind their existing controls.

## Maintenance review

Main exposed escalation for queued Host and Dev requests. System now preserves both targets while retaining the reviewed delay, confirmation and exact-plan exclusions. A pure model regression covers Dev, Host and the approval boundary. The Settings inventory records both environments; README overview and onboarding are unchanged.
