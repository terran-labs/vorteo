### Fixes

- New workspace has its header again. Compact layouts show the menu button, the New workspace title and the project picker in it, and the header steps aside while the composer is fullscreen.
- Import session is back on New workspace: at the top on compact layouts and under the composer on wide ones.
- A subagent's composer cards lead with a pill that names its parent and returns to it.
- Subagent rows for agents on another host name that host.
- Images keep Download in the file toolbar, beside their size, and the button shows a pending state while the download runs. Text files show the same pending state.
- The compact workspace menu has its Scripts row again. It opens a page listing every script, each script has its own page to run, view or stop it, and the menu button carries a dot while a running service is unhealthy.
- Pressing a workspace row in the collapsed sidebar's project flyout closes the flyout.
- The demo's Changes card shows its changes instead of asking to update the host.
- Open Usage in the sidebar's quota popover closes the popover, so its backdrop no longer blocks the Usage screen's controls.
- An `agent.create` plugin hook can rewrite a launch again, such as its model or provider features, as upstream intends. The provider, tool access, the profile and its account environment, skills and the quota reserve stay as admitted, and a profile launch also keeps its model, reasoning, features and instructions.

### Maintenance

- The desktop Import session browser test runs again now that wide layouts have the button.

## Maintenance review

Restores behavior that the November 1 upstream merge's conflict resolution dropped, keeping upstream's fullscreen composer, Scripts pages, parent pill and remote host labels inside Vorteo's layouts. The upstream comparison and plugin API entries in the inventory record the result. Source only; not installed. README overview and onboarding are unchanged. The upstream creation-idempotency test that injects prompt rejections through a profile launch's features is routed out, because profile launches keep their features by design.
