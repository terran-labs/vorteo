### Maintenance

- Split nightly and manual packaged installation CI into independent desktop and phone jobs while preserving all cases and the 90-minute job limit.
- Reuse shared server builds and retain incremental case results and first-load timings when the final report is interrupted, with a 75-minute test budget for cleanup and upload.

## Maintenance review

Updated the CI inventory and testing guide for complete project coverage, build fallback and per-project result retention. Packaged specs, required checks and routing remain unchanged. README overview and onboarding are unchanged. Actual CI durations and complete artifact coverage still require final dispatch acceptance.
