### Fixes

- Refuse daemon lifecycle commands against the implicit managed Host target and direct callers to installation controls.
- Treat CLI home and host selectors as explicit targets without reading installation metadata or changing arguments.

## Maintenance review

Reviewed registered lifecycle routes and selector options. Extended the existing temporary installer test for lifecycle refusals, explicit targets and unchanged agent routes. Earlier forwarding fixes remain intact; README onboarding is unchanged.
