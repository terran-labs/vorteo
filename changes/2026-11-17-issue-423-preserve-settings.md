### Fixes

- Preserve effective permission mode, thinking and feature values when a coordinator switches a thread's account. Refuse incompatible targets, including other provider families, before replacing the source session. App switches are unchanged.
- Gate dry runs and source preconditions so older daemons cannot turn them into real switches.

## Maintenance review

Reviewed account switching in the customizations inventory and protocol compatibility guidance. Saved-history readers and storage are unchanged. README overview and onboarding are unchanged; detailed switching behavior belongs in the existing inventory.
