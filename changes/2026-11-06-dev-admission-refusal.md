### Fixes

- Show Dev's reason when it refuses delegated agent creation for a settings admission failure, such as an unreachable coordinator, instead of a bare 500.

## Maintenance review

Delegated Dev agent creation relays Dev's settings admission refusal as a 502 with that cause. The Host never had a 5 second creation deadline: its client waits for Dev's reply and the installation client allows 60 seconds, so the 500 came from the coordinator masking Dev's reported error. Admission errors carry the optional `installation_settings_admission` creation error code, the client keeps a creation failure's code on the thrown error, and only that code's messages are relayed. A test asserts the installation client deadline stays at least twice Dev's 5 second admission timeout. Source only; not installed. README overview and onboarding are unchanged.
