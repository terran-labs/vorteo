### Fixes

- Start live development on installations whose main address is a custom domain, using their private `.ts.net` address for the dev server.

## Maintenance review

Live dev required the canonical public origin to be `.ts.net`, but this installation's canonical origin is its custom domain, with the `.ts.net` address as the recovery origin, so Lab never started live development. The coordinator now picks whichever configured origin is `.ts.net` for the dev server and forwards the other address, page requests and the Fast Refresh socket alike, by presenting the `.ts.net` origin upstream. The Expo patch is unchanged. Coordinator change; needs a Host update and coordinator follow. README overview and onboarding are unchanged.
