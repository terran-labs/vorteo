### Fixes

- Claude and Codex connections that sign in with an API key, token, gateway or cloud provider are no longer treated as having no credentials, so a primary connection of that kind still launches. Only a Claude full sign-in account with an empty credential store counts as having none.
- Codex usage reads no longer fail on an API-key sign-in file.

## Maintenance review

Addressed the third and fourth reviews of the primary connection. The inventory entry records which readings report missing credentials. README is unchanged.
