### Features

- Installation owners can choose worker presets from several providers for a supervisor. The daemon chooses a permitted account using each account's lowest remaining quota window and the owner's quota floors. The supervisor can reopen a worker from its saved history after a provider reports a usage limit.

## Maintenance review

The installation profile editor and both connected daemons must support worker teams. Existing single-worker presets retain their account selection rules. The per-account Automatic switch also applies to team workers.
