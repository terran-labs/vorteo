### Fixes

- A Factory page opened before its host connects says it is loading instead of "Factory unavailable". The plugin catalog sync treated a host that had not yet reported its features as one without plugins, so a cold start against a slow or unreachable host marked the catalog settled with no Factory plugin until the connection completed (#637). The catalog now stays loading until the host first reports whether it supports plugins.

## Maintenance review

Investigation of #637, which the owner saw on a desktop web app and which cleared without a code change. The single-Factory route shows "Factory unavailable" only when the host's Factory plugin is missing after its catalog has finished loading. This fixes the one path found that reports a missing plugin as settled, during a cold start before the host's server info arrives. The page already recovers by itself once the plugin installs. No inventory entry changes, and README overview and onboarding are unchanged. Interface only.
