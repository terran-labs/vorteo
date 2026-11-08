### Features

- Host agents can start agents in the Dev container that report back. The installation saves Dev as a connected host named "Dev container" on the Host daemon, so the ordinary agent tools with `serverId` create Dev agents with labels and a parent link, deliver their finish notices and read their status and activity.
- Creating an agent on another host accepts `profileId`, a saved preset on the destination. The destination applies the preset's model and instructions, and the provider still selects the account.

### Maintenance

- Disabling the saved Dev host keeps it off. The coordinator only follows a changed Dev password, detected by a hash of the connection stored in the registration's metadata.

## Maintenance review

First step of running Factory issue agents in Dev. The coordinator's new `dev-host-link.ts` pass runs every 60 seconds beside project sync. It needs a coordinator update and the Host daemon's `connectedHosts` support, which current daemons have. Remote creation forwards `profileId` in the session config, a field the wire schema has carried since 2026-09-09, so it needs no new capability. The connected-hosts end-to-end test now covers a destination preset and labels, and one unit test covers registration, a password change and the owner's opt-out. Updated the agent management and connected-hosts docs and the Host orchestration inventory entry. README overview and onboarding are unchanged. Not installed.
