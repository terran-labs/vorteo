### Fixes

- Bound CI website browser installation to two attempts within 12 minutes, normalize the observed slow EC2 Ubuntu archive route, and report dependency and browser phase timings. Preserve Chromium, WebKit and their OS dependencies; require lock release and bounded dpkg recovery before retrying interrupted dependency installation.

## Maintenance review

Updated the CI customization inventory and testing guide with the measured apt bottleneck, retry safety and hosted verification limits. README overview and onboarding are unchanged because this repair affects CI installation only. Hosted throughput acceptance remains pending.
