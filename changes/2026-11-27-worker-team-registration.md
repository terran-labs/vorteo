### Fixes

- Agent sessions admitted before a restart hold can finish registering and join the drain. The published configuration schema includes worker team membership.

## Maintenance review

The agent manager checks shutdown after saving a team worker's authority and keeps new agent starts behind the restart hold.
