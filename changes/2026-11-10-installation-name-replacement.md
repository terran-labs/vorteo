### Fixes

- An installation name containing `$'`, `$&` or similar no longer breaks the page's startup script or its title, because the served page inserts the name literally.

## Maintenance review

The web UI injection uses function replacers for the title and the head script, and the descriptor test covers a name with replacement patterns. The boot page's recovery link reader carries the `COMPAT(recoveryOriginGlobal)` tag with a version-based removal condition. README overview and onboarding are unchanged.
