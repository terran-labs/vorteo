### Maintenance

- Repair the System pane test fixture so desktop runtime detection and imported settings dependencies load without missing mock exports.

## Maintenance review

Test-only correction. The unchanged fixture fails with the missing Platform export at both the pull request base and integrated commit. Partial React Native exports, an unused owner-access hook that throws if called, and an isolated blocked-work card let all eight existing behavior tests run and pass. Production settings, keyboard behavior and owner authorization are unchanged. README overview and onboarding are unchanged.
