### Fixes

- A Factory adoption recovery fence left from before the controller's retirement no longer blocks Dev restarts and broker dispatch; the coordinator clears it at startup and notes why on the failed request.
- A workspace whose only Factory membership came from the retired controller is archived automatically when its folder disappears, like other ordinary workspaces.

## Maintenance review

Closed the re-review notes on the Factory controller removal: the retired adoption fence clears at activation under `COMPAT(retiredFactoryAdoption)`, workspace reconciliation uses the active membership check, the boot-entry switch docs point failed switches at Dev supervisor repair, and the inventory marks the switch live since 2026-11-04 with one retired adoption entry. README overview and onboarding are unchanged.
