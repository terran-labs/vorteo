### Fixes

- Handle SIGTERM and SIGINT before session host startup awaits, and close a listener still starting before exiting.

## Maintenance review

Preserve the reviewed session host implementation and regression test while merging main's release preparation. Move the fix note into a change fragment and keep main's changelog and release version unchanged. The durable provider sessions inventory already describes the fix. README overview and onboarding are unchanged.
