### Fixes

- A bare `paseo-preview status` on the Host answers at once from the broker's published state. It used to send one broker request for each reserved preview, one after another, which took minutes and printed nothing until it finished.

### Maintenance

- The preview broker records why it stopped a preview: an explicit stop, its server exiting, a daemon restart with the restart time, a configuration or process change, or an unavailable workspace. A restart is named only when the preview was verified under the previous daemon worker within two minutes before the new one started; otherwise no cause is recorded. Each broker run writes every reservation's state to `preview-status.json` in the owner-only preview channel. Nothing shows these yet (#586).

## Maintenance review

Updated the private workspace previews entry with the recorded stop causes, the published status file and the faster status command. The container broker never names a restart because its daemon identity carries no wall-clock start time. The published-status path is its own exported function, `printPublishedStatus`, called by `paseo-preview.mjs` before the broker client, to keep the client within the lint complexity limit. Needs a preview broker deployment; no daemon restart. README overview and onboarding are unchanged. Source only; not installed.
