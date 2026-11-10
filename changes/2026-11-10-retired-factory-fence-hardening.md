### Maintenance

- The retired adoption fence clearing applies only to failed adoption requests, and the docs describe the clearing and the boot-entry switch preflight accurately.

## Maintenance review

Hardened the retired Factory adoption fence clearing to failed adoption requests, consistent with the fence check; the test also proves the adoption is never replayed. Compatibility tags on this branch name the release after 26.11.902, since commits no longer assign versions. Installation docs and the inventory entry describe the startup clearing, the rollback caveat and the preflight refusals. README overview and onboarding are unchanged.
