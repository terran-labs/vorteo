### Fixes

- Refreshing a workspace right after switching its branch shows the new branch. It could keep the old one when the refresh arrived while the daemon was still reading the workspace, for example just after the project was opened. Refs #675.

## Maintenance review

A forced manual refresh (`checkout.refresh`) that arrived while another forced refresh was in flight, such as the one `workspace.create` starts with reason `open_project`, joined it and returned its pre-checkout snapshot. Nothing re-read afterwards, so the workspace kept its old branch until its next Git event. The handler now passes `afterInFlight`, which queues a replay after the running refresh. Found with an instrumented run of `command-center-workspaces.spec.ts:154`: on the e2e worker daemon, the first refresh right after the checkout returned and kept `main`, and a second refresh three seconds later read the new branch. The coalescing and the opening refresh both date from April. Which change in the batch with #686 made the test fail every time is not established. The workspace Git service suite gains a case that fails without `afterInFlight`, and the checkout session case asserts the handler requests it. Updated the workspace Git fetch entry in the inventory. README overview and onboarding are unchanged.
