### Tooling

- The upstream phone sheet test now taps a Subagents card row twice, matching Vorteo's phone behavior where the first tap shows the row's details and the second opens the subagent.

## Maintenance review

Test helper only; no shipped behavior changes. Upstream #6827 and #8093 open a subagent from one tap on its supporting card row, but Vorteo's 2cf5e0cbb made the first phone tap show the row's details tooltip, as the Bounded worker teams entry in the customizations inventory records. The single tap left the sheet closed, and the test's cleanup then removed the project, so the failure screenshot showed the new workspace page and looked like a redirect. Daemon instrumentation confirmed that the only workspace removal came from that cleanup. Desktop rows still open with one click. The customizations inventory and README need no updates.
