### Fixes

- Coordinator settings changes no longer accept preview broker keys, which name programs the coordinator runs; those keep their own reviewed deployment workflows.
- Coordinator updates, coordinator settings changes and custom domain changes share one restart check, so none starts beside another, a release upgrade, an approved Host job, an open coordinator request or a lab self-update.
- A coordinator settings change whose restart cannot be followed, or whose handoff helper is missing or fails to start, now fails cleanly and restores the previous configuration. An unreadable settings journal is moved aside instead of stopping the coordinator.

## Maintenance review

Addressed the coordinator settings review: narrowed the registry to Host-owned refresh flags, added a shared coordinator restart check used by coordinator updates, settings changes and custom domains, hardened handoff launch and journal recovery, and judged silent restarts against the configuration bytes the coordinator parsed at startup. README overview and onboarding are unchanged.
