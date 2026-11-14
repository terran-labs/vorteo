### Fixes

- Permit Chromium to chroot inside its user namespace without adding container capabilities. The Dev seccomp profile is generated from pinned upstream plus six documented exceptions and verified in full. Applying it requires container recreation.

## Maintenance review

Updated the Dev sandbox inventory with the proven chroot denial and recreation requirement. README overview and onboarding are unchanged. Browser acceptance through a provider remains required after installation.
