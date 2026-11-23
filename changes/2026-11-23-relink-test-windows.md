### Maintenance

- The re-link test's "unreadable registry" case puts a directory where the registry file was, so the read fails on every platform. It used chmod 0o000, which on Windows only sets the read-only flag and leaves the file readable, and which root can read anyway (#587).

## Maintenance review

Test only; no shipped behavior changes, so no inventory entry changes. README overview and onboarding are unchanged. Source only; nothing to install.
