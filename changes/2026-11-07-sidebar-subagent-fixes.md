### Fixes

- Search from the phone sidebar no longer closes the sidebar, so cancelling Search returns to it.
- Subagents no longer open as their own tabs when a workspace loads before its workspace list arrives; they stay under their parent as before.
- The Claude provider details sheet shows the container sign-in steps only when Claude cannot run, not when it is already signed in.

## Maintenance review

Reviewed the compact sidebar, workspace tab visibility and the Claude provider sheet against upstream #7693, which keeps the compact sidebar open under Search and sheets. Vorteo's own toolbar Search still closed it. Tab visibility resolved subagent roots through the workspace list before that list had loaded, so every child looked like a root and was auto-opened; it now follows the parent chain until workspaces hydrate, covered by one unit case. The upstream test that restores a pre-beta manual order is routed out because the Host now owns sidebar order. Two upstream specs select the first of Vorteo's two "Close menu" controls, and Vorteo's open questions spec waits for the agent before opening the phone sidebar. The customizations inventory and README need no feature updates.
