### Fixes

- Reading the history of a thread the Host closed while idle now returns the same timeline the thread had while running, so open apps keep their place instead of reloading the whole thread. These reads also skip re-reading the thread's transcript, which took seconds on long threads after a reconnect.

## Maintenance review

Saved timeline reads serve a closed thread's retained timeline when it held the full history at close; the daemon records this in prepareAgentForClosure and clears it on archive and Reload agent. Closing a native thread whose history read never completed discards its partial timeline so the next resume hydrates (review of #573). Fallback to the transcript read and the staleness bound are recorded under "Closed threads keep their timeline epoch" in the inventory, which also narrows the open item in "Frozen threads recover after a history replacement". No wire change. README overview and onboarding are unchanged.
