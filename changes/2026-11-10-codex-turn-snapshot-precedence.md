### Fixes

- Keep unversioned Codex collaboration snapshots from overriding an observed child turn. Providers that lack turn observations retain child-state snapshot handling.

## Maintenance review

Codex collaboration snapshots expose no child turn revision or ordering guarantee. Explicit turn observations take precedence over those snapshots. Streams that announce a turn start and omit its terminal retain the running holder until trustworthy lifecycle evidence arrives.
