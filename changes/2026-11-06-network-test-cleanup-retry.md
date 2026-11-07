### Tooling

- Retry the ignored proxy test's temporary home cleanup so a daemon that is still flushing files on exit no longer fails the server suite.

## Maintenance review

The ignored proxy test occasionally failed with `ENOTEMPTY` while removing its temporary daemon home after the worker exited. Cleanup now uses `rm` with bounded retries. The warning assertions are unchanged; product behavior and the customization inventory are unchanged.
