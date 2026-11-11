### Fixes

- Messages no longer cancel a running turn when a restart hold begins while steering or its fallback is waiting.

## Maintenance review

Restart admission is rechecked after provider steering and the asynchronous fallback hook. Two representative regressions verify that the running turn remains uninterrupted. Existing hold release and steering behavior are preserved. README overview and onboarding are unchanged.
