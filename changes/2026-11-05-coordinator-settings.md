### Added

- Installation controls show a **Coordinator settings** card when Builds requests a change to the coordinator's registered settings (Host-owned Claude and Codex refresh). The owner sees each value before and after, and approves or rejects it. When a coordinator update also waits, one decision approves both and applies the settings after the update succeeds. The coordinator restarts on the new settings and restores the previous ones if it does not answer within two minutes. Agents see the change read-only in `update-status`.

## Maintenance review

Added owner-approved coordinator settings changes for installer-layout installations, with a registry of changeable keys, hash-bound requests from the Host agent client and the existing coordinator-config handoff for restart and rollback. They are the supported route for these keys; plan-folder renewal is not used on these installations. README overview and onboarding are unchanged.
