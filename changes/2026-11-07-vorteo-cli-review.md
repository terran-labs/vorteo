### Fixes

- Forward CLI commands to the recorded installation daemon home, including adopted layouts, while preserving explicit target overrides.
- Keep command hints compatible with standalone and Dev callers. Report missing CLI builds or Node runtimes with a repair instruction.

## Maintenance review

Resolved the command forwarding review. Restored upstream developer documentation, existing tests, desktop hints and Factory agent instructions. The shared command-name helper defaults to the compatibility binary; only the Host dispatcher opts into branded hints. README media and installation boundaries are unchanged.
