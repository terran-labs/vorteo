### Fixes

- Run the full CLI through `vorteo` while keeping installation commands local. Forwarded commands preserve arguments, input and exit status; installer `status` and `help` take priority.
- Show `vorteo` in dispatcher-invoked CLI help, actionable hints and Vorteo user guides. Standalone and Dev callers retain `paseo` hints.

## Maintenance review

Reviewed the installer dispatcher, CLI command collisions and user-facing command examples. Updated the command inventory and README onboarding without changing media, package names, environment variables, filesystem paths, Factory charters or the installed shim. Tests use temporary installations and a fake CLI.
