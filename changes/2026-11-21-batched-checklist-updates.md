### Improvements

- Agents can update their thread checklist in one call: `update_checklist` accepts `mutations`, a list of up to 20 changes that apply in order as one all-or-nothing write. Every rule of a single change still applies to each one, a failure applies none of them and names the failing change, and the Tasks card receives one update per batch. Single `mutation` calls are unchanged (#359).

## Maintenance review

Updated the thread checklist entry in the customizations inventory with the batched form. The tool input is daemon-local, so the wire protocol, the app's checklist request and older clients are unchanged. README overview and onboarding are unchanged. Source only; installing it needs a daemon restart.
