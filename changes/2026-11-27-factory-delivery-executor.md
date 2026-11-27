### Maintenance

- Added the Lean Factory delivery executor: a daemon state machine that ships betas, promotions and rollbacks from the accepted commit's recipe without opening an agent session. It survives a daemon restart in any state and never repeats a deploy on its own. A step whose outcome was lost waits for the owner to verify, rerun or abandon it. A promotion needs the owner's recorded approval of that exact beta. Host steps need the merge gate's record for that exact commit. Release values reach commands only as environment variables, and step output stays out of the ledger. Nothing calls it yet, so behaviour is unchanged.
- Added Mira's recipe as an example configuration that wraps its existing ship and rollback tools.

## Maintenance review

The executor is covered by a focused case table: restart at each state, no second deploy after an interrupted one, refused promotions, refused Host steps and hostile release values. It is not wired into the reconcile loop, and the Host adapter, the merge gate record and Mira's real tools have not run through it.
