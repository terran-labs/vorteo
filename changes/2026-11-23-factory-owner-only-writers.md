### Security

- Only the owner's app can now name which thread holds a Factory role or change the presets Factory launches (#360). `factory.project.enable` with `adopt`, and `factory.project.configure` when it sets a role's provider or profile, the planner, worker or reviewer profile, or where issue agents run, are refused for the CLI and any other non-app client, and each refusal is logged with the writer, method, fields, project and role. Enable without `adopt`, `configure` with only `planning`, `status set` and every other Factory call behave as before.
- Factory no longer adopts a thread as the Foreman because it wears the Foreman's role label. If the Factory state file is lost, enabling Factory again reuses the other labelled role threads but creates a new Foreman, and logs the labelled thread it passed over so the owner can archive it.
- Limitation: the client type is self-declared (#525), so this stops agent tools, the CLI and accidents, not a process holding the daemon credential that claims to be the app. The app has no control for where issue agents run, so `--issue-agents` can no longer be changed until it gains one; the current setting is kept.

## Maintenance review

Issue #360, slice S0 of the Factory stage rule (C1b). Updates the Factory entry for the owner-only writers and the Foreman label change, and documents the new CLI refusals in docs/factory.md. Covered by one case table in the existing session test (each owner-only writer refused for a CLI client and allowed for the app, plus the calls role threads still make) and one revised case in the Factory service test. No wire change. README overview and onboarding are unchanged. Not installed; installing needs a Host daemon restart.
