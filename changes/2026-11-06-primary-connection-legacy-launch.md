### Maintenance

- Installation daemons use the primary connection only once their coordinator supports it. Under an older coordinator, the Optimizer and Factory keep launching with the first usable provider instead of waiting, and Settings hides the primary connection controls.

## Maintenance review

Primary connection compatibility: new coordinators project `installationPrimaryConnectionSupported` and answer admission and owner reads with the `primaryConnection` key, even when unset. Daemons and the app treat its absence as an older coordinator. The inventory entry describes the fallback. README overview and onboarding are unchanged.
