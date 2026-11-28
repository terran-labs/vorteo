### Features

- Owner apps that ask can now see what a Host or Dev restart is doing and for how long: its step (awaiting approval, waiting to start, preparing the update, waiting for idle agents, holding for running turns, restarting, and the result), when it started and finished, when the hold closed admission and was released, when its deadline falls, and how long each blocking thread has held it, with that thread's current turn start. Coordinator and supervisor maintenance report their start, step and finish too.
- A message the app sends while a restart hold refuses it now carries a `restart_hold` code, so the composer can say why.
- When a hold an agent requested passes its deadline, the job says the requesting agent was not notified. Nothing is sent into its thread.

## Maintenance review

Steps are recorded by the coordinator in its private `restart-progress.json`, never in the restart journal, so a rollback coordinator is unaffected; a missing or damaged file starts a fresh history. Everything is reply-only and sent only to clients that request `operationProgress=1`. "Restarting" covers installing, starting and verifying as one step. Focused tests cover step recording across real transitions, persistence across a coordinator restart, the 16-step cap, the hold starting at admission close, damaged history, a history first seen at startup reporting unknown times, the overdue notice recorded without delivery and restart and maintenance replies unchanged without the flag. Not installed.
