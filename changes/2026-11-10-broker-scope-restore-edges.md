### Fixes

- A broker settings change whose restart outcome cannot be read no longer restores the old participant scope when the coordinator already runs the new configuration, which pins the new scope. Restoring a scope now stages its bytes beside the scope file, so it also works when the scope is on another volume.

## Maintenance review

Closed two low-severity notes from the broker settings re-review: the scope restore honors the configuration that runs, and stages beside the scope file. `writeFileSync` joins the coordinator settings allowlist under the existing sync custody TODO. README overview and onboarding are unchanged.
