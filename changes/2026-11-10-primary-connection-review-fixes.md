### Fixes

- Settings now warns when the primary connection cannot run on the Host, or where a Factory runs, even if it works in another environment, and offers Make primary only for connections ready on the Host.
- An upgrade no longer picks a primary connection while another connection is still loading or briefly failing its usage check.
- A temporary usage check error on the primary connection no longer stops the Optimizer and Factory from starting.
- Factory's message when no connection can start its agents now names the actual causes.

## Maintenance review

Addressed the independent review of the primary connection. The inventory entry records per-environment availability, settled upgrade adoption and the usage error rule. README is unchanged.
