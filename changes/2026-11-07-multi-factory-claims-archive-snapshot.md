### Fixes

- A Factory claim made just as the issue's previous claim is released keeps its ownership instead of reading that release as its own.

## Maintenance review

Review fix for multi-installation Factory claims: a new claim records the archive list after its branch exists, and crash recovery that meets a new archive asks the owner, keeping that question open until the owner decides. Source only; not installed. README overview and onboarding are unchanged.
