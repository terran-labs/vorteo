### Maintenance

- Repair the packaged provider-family case to use the Mock switch name, scope connection actions, and wait for accepted removal, disabled restoration and cleanup across both environments.

- Handle primary-connection disable confirmation, preserve the original primary selection during cleanup, and scope restoration to the named dialog at both widths. Assert persisted rename and removal confirmation, and retain test failures alongside cleanup failures.

## Maintenance review

Updated the packaged installation coverage inventory. This repairs test coverage only; product behavior, README overview and onboarding are unchanged. The first packaged Linux run exposed an unhandled primary-disable confirmation; acceptance of the corrected case remains pending.
