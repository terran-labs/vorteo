### Maintenance

- Added the supervisor access table and a pure comparator for #518 slice 1. It sorts each provider's permission modes into read-only, attended and unattended tiers and decides whether a supervisor may start a child, covering permission tier, Codex read scope, machine-reviewed children, unprompted writes, owner-only Chrome, environment, directory scope and tool access. A child counts as unattended when its supervisor answers its prompts, when it loads configuration the supervisor can write, or when its mode is not authoritative; the daemon must assert those three facts from its own state. Unknown or unverified mappings are reported as unmapped, never allowed. Nothing calls it yet, so behaviour is unchanged.

## Maintenance review

Added one inventory entry for the unenforced supervisor access table under supervised workers, revised to three tiers and three named refusal rules after three independent security reviews. Copilot agent and plan, OpenCode build and plan, and Oh My Pi write stay unresolved. README overview and onboarding are unchanged. Source only; not installed.
