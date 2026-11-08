### Fixes

- Project groups longer than their Show more limit keep active workspaces visible, with the folders that hold them, and lead with the open workspace when the limit would hide it.

### Tests

- Three upstream sidebar tests that seed counts for a 7-row limit are routed out; Vorteo's folder trees keep 20 rows, and one unit case covers the restored rules.

## Maintenance review

Vorteo's folder trees (8ccc81917) replaced upstream's flat group limit with a plain 20-row slice, dropping upstream's rules that active rows stay past the limit and the open workspace leads. The owner chose on 2026-11-07 to restore them. selectLimitedTreeRows applies them to tree rows, keeping each kept row's folder ancestors and rendering the open workspace first, outside the drag list, as upstream does. The customizations inventory and README need no updates.
