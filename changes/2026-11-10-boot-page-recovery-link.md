### Improvements

- The startup error page offers Open recovery beside Reload and Copy diagnostics when the installation has a private recovery address, so the owner can reach the native interface while the main address cannot start.

## Maintenance review

The coordinator writes its recovery origin to the canonical page as a separate global, outside the strictly validated installation descriptor, tagged `COMPAT(recoveryOriginGlobal)`. The boot page shows the link only for an HTTPS origin other than the current one. Needs a coordinator update to take effect; older coordinators show no link. README overview and onboarding are unchanged.
