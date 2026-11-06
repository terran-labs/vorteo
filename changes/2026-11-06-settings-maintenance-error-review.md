### Fixes

- Retain a failed maintenance cancellation for review until Refresh requests is used, including when an earlier status read completes after the failure.

### Maintenance

- Check the post-login System notice in the Settings sidebar, where it now lives. Use the real System section jump for review helpers instead of reloading the whole app between controls.

## Maintenance review

The Settings inventory records durable cancellation errors. The existing model regression now covers a read racing cancellation and a later automatic poll, followed by explicit refresh and a successful exact cancellation. Browser checks retain all owner, queue and connection assertions and their existing deadlines. README overview and onboarding are unchanged.
