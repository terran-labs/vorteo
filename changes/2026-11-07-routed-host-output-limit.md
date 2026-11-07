### Maintenance

- The protocol compatibility guide now says that a routed host transfer larger than 32 MiB has no end-to-end flow control. The routing daemon closes the route when the receiving client falls behind the host link. This explains the intermittent failure of the upstream 50 MiB routed timeline test in the merge queue.

## Maintenance review

Documentation only; transport behavior and tests are unchanged. The routed-host chunking code matches Paseo `eb8b5b8f9`. The 50 MiB test's margin depends on scheduling. On one machine, peak buffering at the routing daemon ranged from 9 to 32 MiB in Vorteo and 11 to 16 MiB in Paseo, against a 32 MiB limit. It passed in ten of ten recent Paseo runs and two of five recent Vorteo merge-queue runs. Per-route credit flow control was proposed and declined by the owner because Vorteo does not use routed hosts. README overview and onboarding are unchanged.
