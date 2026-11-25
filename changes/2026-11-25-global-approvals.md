### Improvements

- A thread stopped on a tool approval that no supervising thread can answer now shows in the sidebar's Open questions card: "<thread> is stopped until you answer.", the thread's mode, its working directory, the reason, and the command. Accept appears once the full command has been expanded; until then the card offers Open thread, which lands on the approval. Deny is one tap. The card's count reads "N open questions and approvals across all threads" (#659).

## Maintenance review

Issue #659, part C. The daemon records each thread's creator as `createdByAgentId` when `create_agent` runs, from the authenticated caller. Labels never change it, no snapshot or record write can replace it, and a record from before the field takes it once from its parent label at load and is written back. Snapshots carry it behind the new `agentCreatedBy` capability; older hosts show no approvals on the card, as before. An approval surfaces when the thread has no creator, or when no ancestor up its creator chain can answer (closed, archived, missing, or itself waiting on an approval). Pending permissions record the timeline position where they were requested, so Open thread lands on them. Tests: the routing table, and the storage rules for the creator. No inventory entry changes; README overview and onboarding are unchanged.
