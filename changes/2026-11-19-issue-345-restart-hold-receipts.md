### Fixes

- Show live restart hold details in installation controls and history, including the option to keep waiting at an ask-mode deadline.
- Preserve failed hold-release reasons and distinguish them from the restart outcome. A confirmed retry keeps the earlier failure without repeating the restart.

## Maintenance review

Updated the execution environments and installation inventory and installation reference. The configurable 15-minute deadline, ask default, recorded automatic choices, cancellation and interruption admission are unchanged. Receipt handling uses existing fields and requires acknowledgement before reporting release. Validation uses fake lifecycle adapters; no live restart acceptance is claimed. README overview and onboarding are unchanged.
