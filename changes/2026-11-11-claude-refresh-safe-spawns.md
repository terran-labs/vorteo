### Fixes

- Claude query starts using the same configuration-directory string share a startup slot within one daemon process. The next start waits for SDK initialization to settle, or for the 15-second limit even if initialization remains unresolved. Other directory keys do not wait.
- Idle cleanup refuses a Claude CLI younger than 60 seconds. Host shutdown still waits at most 10 seconds before closing providers; this does not guarantee that refresh has finished or prevent interruption during token rotation.
- Claude debug-file output is unavailable, including when an existing opt-in file requests it. Private path custody at the SDK write and exclusion of credential material from its output are not established.

## Maintenance review

This is a bounded query-start mitigation, not a refresh-completion or account-wide serialization guarantee. The slot uses the raw configuration-directory string and process-local state; aliases, other daemon processes, later refreshes and probe or login starts are outside its coverage. SDK initialization can finish before a later refresh, and the slot limit deliberately releases unresolved initialization. The existing 60-second CLI-age check does not extend the 10-second host shutdown wait or change restart and force policy.

The debug helper now returns no path and creates no log directory. Directory revalidation before returning a pathname cannot prove custody when the SDK opens it later, and SDK credential exclusion remains unverified. Isolated filesystem fixtures cover private, broadly readable and symlinked paths using synthetic opt-in files, without an SDK, provider, credentials or sensitive log payloads. No existing path permissions or live settings are changed. Foreign-owner fixtures require privileges not used here. The durable sessions inventory records these limits. Delivery and any session-host or daemon restart remain with Builds through the tracked workflow; source approval grants no lifecycle effect. README overview and onboarding are unchanged.
