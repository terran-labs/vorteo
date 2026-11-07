### Features

- The Factory Foreman starts each new lead, worker and reviewer on the account with the most fresh remaining quota for its profile's provider, skipping unknown, stale and exhausted accounts, and records every choice. A reviewer avoids the worker's account, and with no qualifying account the configured default is used. `vorteo factory project pick-account` shows the choice and why each other account was skipped.

## Maintenance review

Quota-aware account choice for Factory agents: a daemon ranker over existing usage readings, a `factory.project.pick_account` RPC and CLI command, recorded picks in the Factory state file, and a Foreman charter change, which triggers its charter review after install. Wire changes are a new optional RPC only. Launch-time only; pooling, in-thread switching and reserves remain planned. README overview and onboarding are unchanged.
