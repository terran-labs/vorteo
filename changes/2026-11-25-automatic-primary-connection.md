### Features

- System threads no longer wait for you to choose a primary connection (#657). Automatic is now the default: the Optimizer and Factory start on the ready, signed-in account with the most usage left, and stay on it while it can run them. A connection you choose is never overridden. Providers shows which account Automatic uses now in each environment, the owner can keep each connection out of Automatic, and Health shows one row only when no account can run system threads.

## Maintenance review

Updated the primary connection entry under Accounts and reusable workflows for Automatic: selection order, stickiness, the per-account switch, Providers and Health display, upgrade adoption and the capability gates for older coordinators, daemons and clients. The Factory worker accounts entry now names Automatic as a default launch source. Review fixes add the per-environment picks, the credential-home check and the owner-only, placement-rule limit, also documented in the providers guide. README overview and onboarding are unchanged: the README does not describe the primary connection. The published config JSON schema is regenerated for the two new optional fields.
