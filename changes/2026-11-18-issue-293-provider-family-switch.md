### Maintenance

- Repair the packaged provider-family case to use the Mock switch name, scope connection actions, and wait for accepted removal, disabled restoration and cleanup across both environments.

- Handle primary-connection disable confirmation, preserve the original primary selection during cleanup, and scope restoration to the named dialog at both widths. Assert persisted rename and removal confirmation, and retain test failures alongside cleanup failures.

- Prepare the environment Codex bindings with the isolated catalog fixture in both daemons, reorder while Mock and Codex are enabled, and restore each recorded command and discovery state. With the #495 fix merged, verify disabled Mock settings and discovery in both environments and re-enable through the visible off-group switch before connection actions. Disable and disabled restoration both require a visible, unchecked switch; re-enable checks the accepted save and convergence before continuing. Packaged acceptance of this combined change remains pending.

- Verify keyboard reordering through pickup state and persisted order in both browser projects. Before dropping, wait for the Codex target announcement inside Mock’s sortable context so the other group cannot match. This synchronizes the target transition without sleeps; packaged verification remains pending.

## Maintenance review

Updated the packaged installation coverage inventory. This repairs test coverage only; product behavior, README overview and onboarding are unchanged. The first packaged Linux run exposed an unhandled primary-disable confirmation; acceptance of the corrected case remains pending.
