### Fixes

- Dashboard sampling cancels as soon as daemon shutdown begins. Shutdown and startup failure cleanup wait for any dashboard write already in progress.

## Maintenance review

The dashboard collector now participates in both daemon cleanup paths. An interrupted startup cannot start a new collector after shutdown begins.
