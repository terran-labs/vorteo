### Fixes

- On the Previews gallery, a badge from an out-of-date preview report now reads "Last known" for every state except an unavailable workspace, so it never passes for current; the opened tile carries the last known state. Before, a stale "Stopped" looked exactly like a current one (#586).
- The opened tile's button waits while a start or stop for that preview is still being sent or still with the broker, as the scripts menu does (#586).
- One preview's pending request no longer briefly disables Stop and Restart on every other row of the scripts menu (#586).

## Maintenance review

Review fixes within the gallery state from the same pull request; the inventory entry is unchanged. The badge table and the live link matching table gain rows: stale states, a port prefix in either direction and a non-https reservation. Interface only. README overview and onboarding are unchanged. Not published.
