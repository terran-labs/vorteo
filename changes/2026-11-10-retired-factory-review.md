### Fixes

- Workspaces that still carry a membership from the retired Factory controller can be archived, moved and adopted into Vorteo System again, and no longer block archiving other workspaces in the same folder.
- A project with an old Factory checkpoint no longer keeps its key fixed during Host and Dev project synchronization, and Vorteo System can archive it when it is emptied.
- Factory runtime adoption and a Dev boot switch back to the Factory launcher are refused with a clear error, because both started the removed controller runtime.

### Maintenance

- Open Factory in the Factory workspace menu uses the same destination as the Factory card.

## Maintenance review

Addressed the review of the Factory controller removal. Retired controller memberships and checkpoints are inert, tagged `COMPAT(retiredFactoryMembership)` and `COMPAT(retiredFactoryCheckpoint)`; daemons report the sync factory flag as false while the coordinator still honors it from older daemons. The adoption module is removed and the launcher boot form is refused at advertisement, dispatch and preflight. Installation docs and the inventory entries for startup adoption and the boot-entry switch describe the retirement. README overview and onboarding are unchanged.
