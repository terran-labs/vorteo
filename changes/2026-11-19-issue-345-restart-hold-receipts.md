### Fixes

- Show live restart hold details in installation controls and history, including the option to keep waiting at an ask-mode deadline.
- Preserve failed hold-release reasons and distinguish them from the restart outcome. A confirmed retry keeps the earlier failure without repeating the restart.
- Store fixed hold-release failure categories instead of untrusted diagnostic text, including safe projections of recovered receipts. Preserve cancelled outcomes when their holds are released.

## Maintenance review

Updated the execution environments and installation inventory and installation reference. The configurable 15-minute deadline, ask default, recorded automatic choices, cancellation and interruption admission are unchanged. Security review replaces pattern redaction with a closed four-category vocabulary. Reads project old failures without journal writes; repeated retries retain each category once. Hostile fake-adapter coverage includes arbitrary error codes, two-million-character diagnostics, recovery, repeated reads and retries, acknowledgement and cancelled legacy jobs with no extra dispatch. Receipt handling uses existing fields and requires acknowledgement before reporting release. Validation uses fake lifecycle adapters; no live restart acceptance is claimed. README overview and onboarding are unchanged.
