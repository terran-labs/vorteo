### Fixes

- The Dev container's preview broker can accept a reviewed tailnet access scope change on the same node with `install-https-broker.py --accept-access-scope`, like the native broker. Before, a device joining or leaving the tailnet left the Dev broker refusing every preview with "Tailnet access scope changed" and no supported way to recover.

## Maintenance review

Reviewed the broker README's access scope section and the customizations inventory. The container installer now records `accessScope` and accepts a changed packet-filter hash only with `--accept-access-scope`, only when node ID and hostname are unchanged; without the flag it refuses and prints grants added and removed with device names. File replacement and the config write run under the broker's lock and refuse if the config changed after it was checked. `access_scope`, `device_names` and `scope_change` moved unchanged from the native installer into a shared `access_scope.py`, which the native installer imports. README overview and onboarding are unchanged. Source only; not installed.
