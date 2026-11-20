### Maintenance

- Added the supervisor access table and a pure comparator for #518 slice 1. It orders each provider's permission modes into five levels and decides whether a supervisor may start a child, covering permission level, owner-only Chrome, environment, directory scope and tool access. Unknown or unverified mappings are reported as unmapped, never allowed. Nothing calls it yet, so behaviour is unchanged.

## Maintenance review

Added one inventory entry for the unenforced supervisor access table under supervised workers. Copilot agent and plan, OpenCode build and plan, and Oh My Pi write stay unresolved until an independent security review. README overview and onboarding are unchanged. Source only; not installed.
