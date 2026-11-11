### Fixes

- Old Factory installation checkpoints are treated as inert data, so they no longer block project archive, removal or system project adoption, or prevent older records from loading.

### Maintenance

- Remove the unused Factory membership service and binder while keeping per-project workspace protections, and update the Factory documentation.

## Maintenance review

Old Factory installation checkpoints are inert data preserved on rewrite and no longer block project lifecycle operations. The unused Factory membership service and binder are removed; per-project Factory and native workspace membership protections remain. Project synchronization still keeps the key of a project that carries an old checkpoint. The README and docs index now describe per-project Factory.
