### Fixes

- Stop the main workspace pane rerendering while the Explorer is dragged. The header's "new terminal from profile" action was rebuilt on every workspace render, which rebuilt the header and the pane with it.

## Maintenance review

Follow-up to the settings redesign from its full CI run. The terminal-profile action now keeps one identity, like the plain new-terminal action beside it. The Explorer drag end-to-end spec's rerender assertion held in three local runs; two of those runs then timed out on a slow reload under load, so CI is the deciding evidence. README is unchanged.
