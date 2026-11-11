### Fixes

- Read saved history without starting a provider when a thread has neither a native handle nor retained switch history. After a timeline load fails, polling retries after 30 seconds.

## Maintenance review

History requests for unloaded threads without a native handle or retained switch use the saved timeline path. Native-only history and retained switch replay still use their existing readers. The README overview and onboarding are unaffected.
