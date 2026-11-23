### Maintenance

- A preview restart outcome, `preview.restart`, now names the request it belongs to in an optional `mode` field (`"start"`, `"restart"` or `"stop"`), so the app can say a stop failed instead of showing a failed start (#586).
- Stopping a preview through the broker is no longer refused because the preview needs review, its workspace is archived or three starts are already running. Stopping is always safe, and before this the owner could be unable to stop anything for about two and a half minutes. A stop still needs the daemon password and waits for any request already running for that preview (#586).
- When two services of one workspace claim the same reserved origin, the daemon drops the origin from both, so a forged or stale reservation file cannot make a Previews gallery link match the wrong preview (#586).

## Maintenance review

Updated the private workspace previews entry with the stop exemptions, the outcome's `mode` and duplicate origins. The wire field is optional and covered by the existing wire compatibility suite. Duplicate origins are dropped within a workspace only; a forged origin naming another workspace's preview is left to the gallery, which must show no state for an origin claimed more than once. Needs a Host daemon restart, and Dev for Dev previews. README overview and onboarding are unchanged. Source only; not installed.
