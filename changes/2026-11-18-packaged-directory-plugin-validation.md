### Maintenance

- Repair the packaged directory plugin test to check the exact validation message and Save state within the creation dialog, reload and open Manage plugins after creation so prior tests cannot change catalog access, follow the directory action to the Host route and verify its dialog opens, then edit each environment directory through its settings dialog. Reopen the Plugins catalog after returning to settings before checking both running states.

- Scope environment edit triggers to the visible settings page and exceptions toggles to their target dialog so retained hidden routes cannot match.

## Maintenance review

Product behavior, the customizations inventory, and README overview and onboarding are unchanged. This repair changes the existing packaged test case and its shared Settings helper, and preserves its shared definition, separate environment paths, and running-state assertions.
