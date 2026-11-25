### Fixes

- A failed session host install, remove or restart keeps counting on Health until the same operation succeeds; a successful restart no longer hides a failed install (#639).
- A Health Fix opens its card once. A Fix whose card was not there, such as a restart that finished meanwhile, no longer opens the Restart sheet later when another request arrives. After an unlock, Fix follows the unlocked row for the same card, so a Dev restart opens Dev's sheet (#639).
- Health compares request times as times, so a record with fractional seconds orders correctly against one without (#639).

## Maintenance review

Review follow-up to the System Health Fix change; the System status and restart controls entry already describes the behavior. Interface only; not installed. README overview and onboarding are unchanged.
