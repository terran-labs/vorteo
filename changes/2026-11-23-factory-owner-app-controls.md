### Features

- The Factory stage controls in the app now include where issue agents run, Dev or This host (#360). Choosing This host asks for confirmation first, because the project's code then runs on this host, and the picker shows why Dev is unavailable when it is. It is hidden on daemons that do not report the setting.
- A thread that wears the project's Foreman label while no Foreman is recorded, which is what a lost Factory state file leaves, offers Make this thread the Foreman in its tab menu. It asks for confirmation and turns on Factory with that thread adopted as the Foreman.

### Security

- Turning on Factory no longer creates a second Foreman when the state file was lost but the old Foreman still runs. It refuses with the code `factory_foreman_unadopted` and changes nothing, so the owner can adopt that thread from the app or archive it.

- The app's connection probe for a host reached through another host now declares itself as the app, like every other app connection. It declared itself as the CLI, and when it became the active connection the owner's owner-only writes on that host were refused.

## Maintenance review

Issue #360, the app controls that ship with the owner-only Factory writers (stacked on #622; the two install together). Updates the Factory entry and docs/factory.md. Covered by a revised lost-state case in the Factory service test, one session case for the coded refusal, a case table for when Make this thread the Foreman is offered and a case for the This host confirmation in the existing model test, the existing tab menu test, and one host runtime case pinning the declared client type of an ordinary connection and of the routed probe. No protocol field or capability: the refusal uses the existing optional `rpc_error` code. README overview and onboarding are unchanged. Not installed; installing needs a Host daemon restart and the interface publication.
