### Fixes

- Stopping a preview whose workspace is archived now stops its server. Before, the broker withdrew the link and recorded the stop, then failed while checking the workspace, so the server kept running and the stop was reported as failed. If the daemon no longer knows the workspace at all, the link is still withdrawn and the result says the service could not be found to stop (#586).

## Maintenance review

Updated the private workspace previews entry with the archived-workspace stop. Start policy still applies to every start and restart. A case in the existing broker tests covers both outcomes, and the native runtime case checks the real lookup by exact name. README overview and onboarding are unchanged. Needs the broker deployment through Builds' preview-broker workflow; no daemon restart. Source only; not installed.
