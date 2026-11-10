### Fixes

- The primary connection waits instead of launching when its account has no credentials, and a setup-token connection that has never hit a limit still launches.
- An upgrade asks the owner to choose a primary connection when another connection's sign-in cannot be confirmed, instead of waiting forever.
- Installations on an older coordinator keep the earlier launch rule exactly.

## Maintenance review

Addressed the second review of the primary connection. Usage readings gain the optional `credentialsMissing` field for Claude and Codex accounts with no credentials. The inventory entry records the launch and adoption rules. README is unchanged.
