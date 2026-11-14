### Fixes

- Keep previews inside the workspace that published them. The Previews card opens on this thread and can widen only to this workspace; the daemon no longer sends a card, an owner action or an agent's feedback request anything from another workspace.

## Maintenance review

Owner correction to the Previews gallery: the wider view listed previews from every workspace. Scoping is enforced by the daemon from the asking thread's workspace, and lineage keys, version numbers and variant sets are counted per workspace. The list and action requests gain an optional thread id; a request without one sees nothing. The guide and inventory describe the scope. README overview and onboarding are unchanged.
