### Fixes

- Allow release updates after tracked Host source merges when a clean merge preserves exactly the release tree. Refuse installed changes missing from the release and retain the installed prerequisite in the staged bundle.

## Maintenance review

Reviewed release update safety and source receipts. Staged integration commits retain both histories and use the release tree; upgrade records retain the reviewed release revision. README overview and onboarding are unchanged.
