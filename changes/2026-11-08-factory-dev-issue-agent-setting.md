### Changes

- Factory now runs the Foreman's per-issue leads, workers and reviewers in the Dev container by default, because they run the repository's code, while the Factory role agents stay on the Host. `vorteo factory project configure --issue-agents host` keeps them on the Host. Existing Factories move new issue agents to Dev when this ships; running ones finish where they are.
- `vorteo factory project show` reports where issue agents run and whether Dev can take them. When Dev is unavailable, the Foreman waits and says why instead of starting issue agents on the Host.
- The Factory queue includes issue agents running on Dev, even after a switch to host mode, and still shows the Host's agents when Dev cannot be read.

## Maintenance review

Added an optional `issueAgents` setting (`dev` or `host`, absent meaning `dev`) to Factory configure input, stored workers and project state, an optional `issueAgentHost` on project state and the queue, and an optional `serverId` on queue agents; the CLI sends `--issue-agents` only when given and asks for a daemon update when an older daemon refuses it. The service finds Dev through the owner's saved connected host with the Dev source key, ignoring same-key entries from other sources, reads Dev's agents through the connected-host route outside its serialize lock, and counts only those labeled with this installation, in either mode while the owner's Dev host exists. The Foreman charter renders Dev placement in dev mode, including Dev-side worktree cleanup, and in host mode adds a paragraph for issue agents already on Dev, so its version changes in both modes and the existing review flow re-sends it. Builds and Mechanic are unaffected. README overview and onboarding are unchanged. Not installed.
