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

Pass `--expires-at <ISO time>` to make a credential stop working at that time; live sessions are disconnected when it expires. Only the principal that issued a service principal, or the owner, can change its grants or revoke it.

`--read-only` grants `workspace.read`, the only permission a service principal can hold today. The others are refused until [resource-scoped grants](#resources) exist: `daemon.read` returns daemon configuration, which carries provider environment variables such as API keys, and the write, manage and access permissions are owner-equivalent because agents and terminals execute code. The issuer can grant only permissions its own session holds.

Service sessions may send only an explicit list of operations: `project.list.request`, `fetch_workspaces_request` and `fetch_agents_request` for observation, the five agent-grant operations below, and `subscription.release.request`. Every other operation is refused before permissions are considered, so a new operation stays closed to service principals until it is reviewed and added in `authorization/service-restrictions.ts`.

Service sessions read individual agents (fetching one, its timeline, or following it) only through agent grants, never through daemon-wide `workspace.read`. Directory data they receive with `workspace.read` (agent and workspace lists, project lists and their updates) is projected at the transport to identity, status and timestamps: paths, permission requests, journals, questions, errors, runtime metadata, scripts, terminals and git or forge state are replaced with empty values. Give external applications an [overview observer token](execution-installation.md#read-only-overview) or exact agent grants; daemon-wide `workspace.read` is meant for the installation coordinator's own overview principal.

A second, computed layer also refuses any operation whose request carries a path-addressing field, every terminal operation and every `hosts.*` routing operation, because file, git and terminal requests take an arbitrary `cwd` or `path` and would read any file the daemon can, including its owner credential. Allowed observation still returns agent timelines, which can contain anything an agent printed.

Creation prints a token once. The daemon stores only its SHA-256 hash in `$PASEO_HOME/service-principals.json` (mode 0600). A client presents it in `hello.auth` as `{kind: "serviceCredential", token}`; with `@getpaseo/client`, pass `serviceCredential` to `DaemonClient`. Daemons that support this advertise `server_info.features.servicePrincipals`. The session holds exactly the principal's permissions and every operation is checked against them. Service tokens grant nothing as an HTTP or WebSocket header bearer.

Revocation is immediate: the daemon removes the principal's authority from its live sessions, closes their sockets and refuses the token afterwards. Revoked principals stay listed for audit. If `service-principals.json` cannot be parsed, the daemon admits no service principal and refuses changes rather than overwriting the file, so its revocation history survives until it is repaired.

A daemon without a password admits any client that presents no credential as owner, so it refuses to issue service credentials.

### Agent grants

A service principal can also hold agent grants: resource-scoped authority over specific agents, separate from daemon-wide permissions. Each grant lists actions and the agents it covers. `agent.message` and `agent.cancel` name exact agent IDs only. `agent.read` may also name workspaces, covering every agent they own, including full-tool agents created there later, with their pending permission requests and timelines. Prefer exact agent IDs; Vorton's grants use exact IDs only:

```json
[
  { "actions": ["agent.read", "agent.message", "agent.cancel"], "agentIds": ["<lane agent id>"] },
  { "actions": ["agent.read", "agent.message"], "agentIds": ["<intake agent id>"] }
]
```

| Action          | Operations                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `agent.read`    | `fetch_agent_request`, `fetch_agent_timeline_request`, `agent.timeline.set_subscription.request` |
| `agent.message` | `send_agent_message_request` with `activeTurnBehavior: "steer"` and text only                    |
| `agent.cancel`  | `cancel_agent_request`                                                                           |

Pass grants with `paseo access service create --grants-file <json>` and replace them with `paseo access service set-grants <id> --grants-file <json>`. Changing grants disconnects the principal's sessions so they reconnect with the new grants. Issuing grants requires the issuer to hold `workspace.read` and `workspace.write`. Daemons that support grants advertise `server_info.features.serviceAgentGrants`.

Grant checks use exact agent IDs; prefix and title resolution would reveal other agents. A granted message is plain steering text: it cannot set a session mode, attachments, images, `origin` or sender attribution, and text starting with `/` is refused because it would run provider commands and skills, such as `/rewind`. The daemon wraps every service message between `[Message <tag> from service credential "<label>", not from the owner]` and `[End of service credential message <tag>]`, which the agent and the timeline both show, and never records it as owner evidence. The tag is random per message, so text cannot imitate either marker, and the label loses control, format, line-separator, quote and bracket characters. A leading `@` in a word becomes a full-width `＠`, because Claude expands `@path` mentions into file contents without any tool call; email-style addresses are unchanged. A granted message steers without answering the owner's pending approvals, cannot reach archived or internal agents, and does not set the agent's title. Messaging an idle agent starts a turn.

`agent.message` is delegated action, not read access. The target agent acts on the caller's text with its own tools, which can include running commands, editing files and creating or prompting other agents. A message grant on a full-tool agent therefore lets the credential make that agent do anything it can do. The daemon therefore allows `agent.message` and `agent.cancel` only on agents created with `toolAccess: "none"` (see below), and rechecks that on every request; cancelling a full-tool agent would end the owner's or another caller's turn.

Replies from a granted agent reach the service as ordinary agent output, without a daemon tag. Treat them as untrusted: they reflect whatever text the service sent, and a consumer that relays them to people or other agents must label them as coming from that agent.

Agent grants authorize no other operation: listing agents, workspaces, files and every other operation still need daemon-wide permissions, and path-addressed operations stay refused. A service session must advertise `owned_subscriptions` and `selective_agent_timeline`, so it receives only replies to its own requests and its own subscriptions. The transport delivers a message to it only when every agent the message names is one the session was allowed to address.

### Tool-less agents

The owner can create an agent that cannot call any tool by setting `toolAccess: "none"` in its creation config, for example `createAgent({ config: { provider: "claude", cwd, toolAccess: "none" } })`. Only owner sessions may set it, and only at creation; no later update removes it. Daemons that support it advertise `server_info.features.agentToolAccess`, and the client refuses to send it to a daemon that does not, which would otherwise drop the field and launch the agent with every tool.

It runs only on the Claude provider family, resolved through the provider registry, so `claude-account-*` entries qualify. The daemon launches it without Paseo tools, plugin tools or MCP servers. The Claude provider passes `tools: []`, empty MCP servers with `strictMcpConfig`, no plugins, skills, subagents or setting sources, disabled hooks and a `canUseTool` that denies everything. It refuses permission-skipping modes and provider commands that add CLI arguments. A provider or mode switch that would break these rules is refused, and a tool-less agent never adopts a hosted session, which was launched with its host's tools.

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
