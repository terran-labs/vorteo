# Daemon permissions

The daemon authorizes principals with semantic permissions. RPC names and protocol namespaces are not authority.

## Model

```text
principal -> grants
    |
    +-- authenticated by a device or service credential
    `-- opens a session with equal or narrower authority
```

A principal is the durable identity the daemon authorizes: the owner, a Hub relationship or a [service principal](#service-principals). A credential proves that a device or service represents it. Keep them separate so you can rotate credentials, attach more than one device, and revoke a Hub user without inventing daemon user accounts.

A pairing invitation is neither. It is an expiring, single-use exchange that creates a principal and credential with the permissions selected by its issuer.

## Permissions

| Permission          | Authority                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `daemon.read`       | Daemon status, diagnostics, configuration, and provider information        |
| `daemon.manage`     | Restart, update, configuration changes, providers, skills, and plugins     |
| `tunnel.manage`     | Relay, Hub, service tunnel, and public endpoint relationships              |
| `access.manage`     | Pairing invitations, principals, credentials, grants, and revocation       |
| `workspace.read`    | Projects, workspaces, agents, timelines, files, diffs, and terminal output |
| `workspace.write`   | Prompts, agent control, files, terminals, git operations, and scripts      |
| `workspace.manage`  | Create, rename, archive, and remove projects and workspaces                |
| `automation.manage` | Schedules, heartbeats, and loops                                           |
| `hub.execute`       | Agent lifecycle, workspace titling, observation, and recovery              |

Agents and terminals use workspace authority. Both can execute code and mutate the workspace, so separate write permissions would claim an isolation boundary the daemon cannot enforce.

Connected-host management uses `tunnel.manage`; source-owned connection and metadata replacement
requires the producer or `access.manage`. Routed operations retain both caller and link authority,
see [Connected hosts](connected-hosts.md#ownership-and-authority).

Owner, operator, and viewer are UI presets expanded into explicit permissions. Do not persist them as roles. Adding a permission must not silently widen an existing principal.

Permissions are additive allows. Missing authority denies the operation. Do not add deny precedence.

## Service principals

A service principal is a non-interactive identity for another program, such as a personal dashboard, with permissions the owner chooses. Create, list and revoke them with `paseo access service` or in the host's Settings under Service access:

```sh
paseo access service create --label "Vorton observer" --read-only
paseo access service list
paseo access service revoke <id>
```

`--read-only` grants `workspace.read`, the only permission a service principal can hold today. The others are refused until [resource-scoped grants](#resources) exist: `daemon.read` returns daemon configuration, which carries provider environment variables such as API keys, and the write, manage and access permissions are owner-equivalent because agents and terminals execute code. The issuer can grant only permissions its own session holds.

Daemon-wide `workspace.read` is also narrowed for service sessions. File, git, terminal and other operations address the filesystem by an arbitrary `cwd` or `path`, so they would read any file the daemon can, including its own owner credential. Service sessions are refused every inbound operation whose request carries a path-addressing field, computed from the request schemas, every terminal operation, because scrollback can show secrets, and every `hosts.*` routing operation, because routed sessions carry permissions but not this restriction. They are also refused presence heartbeats and push registration, which would suppress or redirect the owner's notifications, forge repository search, which uses the owner's sign-in, and project suggestions, which reveal provider history. They can still list projects, workspaces and agents and read agent timelines, which can contain anything an agent printed.

Creation prints a token once. The daemon stores only its SHA-256 hash in `$PASEO_HOME/service-principals.json` (mode 0600). A client presents it in `hello.auth` as `{kind: "serviceCredential", token}`; with `@getpaseo/client`, pass `serviceCredential` to `DaemonClient`. Daemons that support this advertise `server_info.features.servicePrincipals`. The session holds exactly the principal's permissions and every operation is checked against them. Service tokens grant nothing as an HTTP or WebSocket header bearer.

Revocation is immediate: the daemon removes the principal's authority from its live sessions, closes their sockets and refuses the token afterwards. Revoked principals stay listed for audit.

A daemon without a password admits any client that presents no credential as owner, so it refuses to issue service credentials.

### Agent grants

A service principal can also hold agent grants: resource-scoped authority over specific agents, separate from daemon-wide permissions. Each grant lists actions and the agents it covers, by exact agent ID or by owning workspace:

```json
[
  {
    "actions": ["agent.read", "agent.message", "agent.cancel"],
    "workspaceIds": ["<lanes workspace>"]
  },
  { "actions": ["agent.read", "agent.message"], "agentIds": ["<agent id>"] }
]
```

| Action          | Operations                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `agent.read`    | `fetch_agent_request`, `fetch_agent_timeline_request`, `agent.timeline.set_subscription.request` |
| `agent.message` | `send_agent_message_request` with `activeTurnBehavior: "steer"` and text only                    |
| `agent.cancel`  | `cancel_agent_request`                                                                           |

Pass grants with `paseo access service create --grants-file <json>` and replace them with `paseo access service set-grants <id> --grants-file <json>`. Changing grants disconnects the principal's sessions so they reconnect with the new grants. Issuing grants requires the issuer to hold `workspace.read` and `workspace.write`. Daemons that support grants advertise `server_info.features.serviceAgentGrants`.

Grant checks use exact agent IDs; prefix and title resolution would reveal other agents. A granted message cannot set a session mode, attachments, images or sender attribution, and it is never recorded as owner evidence. A granted message steers without answering the owner's pending approvals, cannot reach archived or internal agents, and does not set the agent's title. Messaging an idle agent starts a turn.

`agent.message` is delegated action, not read access. The target agent acts on the caller's text with its own tools, which can include running commands, editing files and creating or prompting other agents. A message grant on a full-tool agent therefore lets the credential make that agent do anything it can do. Grant `agent.message` on dedicated agents whose built-in and Paseo tools are disabled. Grant it on a full-tool agent only as an explicit owner decision, and treat text arriving from a service credential as untrusted input. Use exact agent IDs rather than workspace grants, because an agent created in a granted workspace is covered automatically.

Agent grants authorize no other operation: listing agents, workspaces, files and every other operation still need daemon-wide permissions, and path-addressed operations stay refused. A service session must advertise `owned_subscriptions` and `selective_agent_timeline`, so it receives only replies to its own requests and its own subscriptions. The transport delivers a message to it only when every agent the message names is one the session was allowed to address.

## Resources

Permissions are daemon-wide. [Agent grants](#agent-grants) are the first resource-scoped authority; they cover agent operations only. Broader workspace-scoped grants remain future work, and operation classification remains inside the authorization module:

```ts
type Grant = {
  permission: Permission;
  resource: { kind: "daemon" } | { kind: "workspace"; ids: string[] };
};
```

A delegating principal can grant only authority it already possesses. A session may attenuate its principal's grants but cannot widen them.

Workspace-scoped grants require every resource-bearing operation and outbound observation to enforce the same workspace boundary. File preview currently accepts any daemon-readable regular file, so it must gain resource enforcement before workspace-specific access ships.

## Task owner evidence

Owner-principal prompts are retained outside Git under
`$PASEO_HOME/task-owner-evidence/<hashed-task-id>/`. Receipts preserve the exact
text, client message identity, principal, receive time and daemon sequence.
Retries cannot replace earlier text. Later messages remain alongside earlier
ones, so a restriction or revocation is available when reviewing scope.

The task's `read_task_owner_evidence` tool retrieves these records in pages.
Its task binding comes from the daemon, not a tool argument. Read through
`latestSequence` before interpreting supersession. A child task cannot retrieve
its parent's records with this tool. Retrieval guidance lives in the tool
description so owner prompts and transcript text remain unchanged. Records are
retained across task archive and daemon restart.

This is review evidence, not an executable permission grant. Actor, target,
actions and supersession still require interpretation of the original words.
There is no automatic grant extraction or legacy transcript backfill. The
existing owner transport admission does not prove a human typed a message;
client IDs are also caller-supplied. Plugins, agent handoffs and service-principal
messages do not acquire owner provenance from their text. Managed review,
sandbox policy, required checks and draft-only worker boundaries still apply.

Only the owning daemon writes this state. Keep daemon state inaccessible to
untrusted workers. POSIX stores require private directory and file modes;
Windows relies on the private daemon home's ACLs. File contents are flushed
before atomic publication; directory flushing is available on POSIX. These
controls do not defend against arbitrary code running with the daemon's own
filesystem authority.

## Hub

The Hub authenticates as a service principal. Its locally selected grants decide whether it may execute agents, manage the daemon, manage tunnels, or manage access.

Hub user and role identifiers remain opaque external subjects. The Hub may create and revoke linked daemon principals when granted `access.manage`; the daemon does not interpret accounts, organizations, or roles.

Hub enrollment and permission updates exchange these semantic permissions directly. Legacy persisted Hub relationships that contain `hub.execution.*` migrate once to `hub.execute` when the daemon loads them; new relationships never persist or emit transport scopes as authority.
