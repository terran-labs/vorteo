### Fixes

- Run the full CLI through `vorteo` while keeping installation commands local. Forwarded commands preserve arguments, input and exit status; installer `status` and `help` take priority.
- Show `vorteo` in CLI help, actionable error hints, interface command hints and current user guides. Keep `paseo` as the compatibility binary.

## Maintenance review

Reviewed the installer dispatcher, CLI command collisions and user-facing command examples. Updated the command inventory and README onboarding without changing media, package names, environment variables, filesystem paths, Factory charters or the installed shim. Tests use temporary installations and a fake CLI.
