### Maintenance

- The published daemon configuration schema lists the primary connection fields.
- Lightweight server entry points stay off the protocol wire schemas: the daemon primary connection schema now lives beside the installation settings.
- The config reload smoke test keeps a primary connection choice the daemon stored on its own before the test rewrites the file.

## Maintenance review

Primary connection CI fixes: schema regeneration, a lighter import for the daemon primary connection schema, and a reload test that tolerates daemon-written values. No behavior changed. README overview and onboarding are unchanged.
