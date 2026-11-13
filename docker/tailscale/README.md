# Optional preview broker and host recovery

Install Vorteo through the [multiplex installer](../multiplex/README.md). The image already contains Tailscale and serves Vorteo over private HTTPS. This directory contains that runtime support plus optional macOS host tools for agent-managed workspace previews and recovery. These tools are not required for ordinary Vorteo access.

Set `PASEO_SOURCE` to the checkout and `PASEO_DEPLOYMENT_DIR` to the private installation. The broker requires the standard `data/home` bind layout and a deployment directory outside agent-writable mounts. Python 3 and an awake, logged-in macOS user session are required for these optional host tools.

Before installing a broker, grant intended users the container node's preview TCP range 32768 through 60999. Review overlapping grants; the installer does not broaden tailnet policy. Each installation has its own broker and recovery labels, derived from its deployment path. Legacy jobs migrate only when their script belongs to that installation.

## Recovery

On the macOS Docker host, review the scripts, then install recovery using the configuration written by the broker installer:

```sh
PASEO_HOST_CONFIG="$PASEO_DEPLOYMENT_DIR/host-config.json" \
  python3 "$PASEO_SOURCE/docker/tailscale/install-host-recovery.py"
```

It copies the worker outside the checkout and installs a login agent that checks once per minute. An awake, logged-in Mac is required. This does not bypass FileVault or start Docker before login.

From the private deployment directory:

```sh
python3 host-recovery.py status
python3 host-recovery.py pause
python3 host-recovery.py resume
```

Pause before planned Docker maintenance or rollback. The worker starts Docker if absent, with three attempts spaced ten minutes apart. It starts an existing stopped serving container with three attempts spaced five minutes apart. It never recreates a container or restarts a running unhealthy daemon. A running rollback container suppresses replacement recovery. Restore operations run as the agent user with all capabilities removed. Review private `recovery-status.json` and logs when manual attention is needed.

Managed Dev workers retain their process arguments. Preview recovery verifies their selected release, Node executable, supervisor parent, ownership and boot/start identity instead of depending on the process title. Legacy workers retain their existing process-title check; an invalid managed supervisor marker fails closed.

## Preview lifecycle and private HTTPS

### Native Host workspaces

The native adapter serves workspaces registered with the macOS Host daemon. It
uses the same broker reservations, receipts, stop barriers and verification as
Dev previews, with a separate deployment directory and native Tailscale node.
It does not require Docker or restart either agent daemon.

Run `install-native-https-broker.py` with explicit `--deployment`, `--daemon-home`,
`--node`, `--cli-entry` and `--tailscale` paths. The CLI entry must belong to a
compatible installed release. The installer verifies the daemon's loopback
listener, existing tailnet policy and native node identity before installing its
own login consumer. It never broadens tailnet grants. Existing identity or policy
changes require review rather than silent adoption.

The installer prints `helperCommand`. Use that command with the ordinary
`start`, `status`, `restart`, `stop` and `list` arguments below. The helper pins
the native daemon home and supplies the reserved origin to the managed service.
It also installs `~/.local/bin/paseo-preview` and the preview instructions under
`~/.config/paseo-preview/AGENTS.md`. The non-secret
`~/.local/share/paseo-preview/https/installed.json` records the pinned command.
Keep using the owning task workspace, including when its command explicitly
targets an isolated worktree. Do not create a duplicate preview workspace.

Native listener verification requires an IPv4 loopback binding and a matching
managed terminal environment. Process birth timestamps come from macOS libproc;
arguments cannot impersonate environment bindings. Native tasks share the
logged-in user's authority. Native broker state is separate from project source,
but this is not the privilege boundary provided by the Dev container.
When republishing its own reservation, the native adapter permits retained
connections on this node's Tailscale addresses after route removal. A new
reservation, an unrelated address or any remaining listener still blocks reuse.

For a Vorteo UI-only preview, `scripts/preview-static.mjs --directory EXPORT`
serves a sealed preview export through this workflow without starting another
agent daemon. It verifies asset hashes, serves only manifest-listed assets and
rejects unexpected hosts, origins and write requests. Rebuild and restart the
managed preview to select a new export while retaining its HTTPS reservation.
Connecting the preview to an agent environment still requires that environment's
normal authentication and origin policy; serving static assets grants no access.

### Dev container workspaces

On the Mac host, run these commands from this source directory, then install against the retained serving container:

```sh
python3 -B test_https_broker.py
python3 -B test_host_recovery.py
python3 -B test_launch_agent.py
node --test initialize-web.test.mjs
python3 install-https-broker.py --container EXISTING_NAME \
  --allowed-root /absolute/development/root --rollback RETAINED_ROLLBACK_NAME
```

The installer uses Docker mount metadata to locate the existing deployment. It rejects host code or policy targets beneath writable container mounts, preserves configuration backups, installs a bounded login consumer, and updates the persistent helper and instructions without restarting Vorteo. Run the same installer after upgrading these tools. The image also distributes the helper module for new installations. Keep the existing Tailscale identity and grants. Review the current packet-filter scope; installation must not broaden it. The runtime fails closed if that scope or node identity changes.

Agents use the [approved helper workflow](AGENT-INSTRUCTIONS.md). A local preview request means a verified private Tailscale HTTPS link. To admit current and future active registered projects and worktrees without individual grants, install with `--workspace-policy registered`. Each workspace must still resolve through verified host bind mappings, including the persistent container home. Registration does not grant access to host directories outside those mappings. Symlinks, archived workspaces, changed pinned paths, unregistered services, and unsafe listeners remain rejected. The installer retains this policy on subsequent runs when the option is omitted.

The default `--workspace-policy approved-roots` retains the existing restricted behavior: local workspaces must be beneath an allowed root and worktrees additionally require an exact workspace grant. For that mode, use `--approve-workspace WORKSPACE_ID=/absolute/container/worktree/path`. Keep passing the current allowed roots on reinstall; switching workspace policy does not change tailnet grants, node identity, or unrelated mappings. The installer backs up the previous configuration and broker code before applying the update, without restarting Vorteo.

Requests contain only lifecycle operation, workspace ID, service name, request ID, timestamp and optional preferred frontend port. The filesystem inbox is the only request interface. No Docker or Tailscale socket is exposed to agents.

The host resolves live daemon workspace and script records, checks the configuration fingerprint and managed terminal, and verifies the actual loopback listener process before publishing. It reserves a stable frontend, writes startup origin configuration, and starts the registered command through the existing unprivileged daemon CLI. The command wrapper supplies `PASEO_PREVIEW_ORIGIN` at launch. Applications must consume it where framework hosts, callback URLs or WSS origins need explicit configuration. A caller's environment does not reach a daemon-launched service.

The mapping ledger, deduplication journal and lock remain outside agent-writable mounts. Repeated start adopts an unchanged owned mapping without probing its occupied frontend or replacing it. Stop persists its barrier and removes the exact owned route before stopping the service. Old queued starts and replays cannot undo a stop.

Install with `--restore-after-restart` to restore verified previews after a daemon or retained-container restart. The broker records the daemon process identity after successful verification. When that identity changes, it removes the stale route and starts the same service only if its workspace remains active and its path and command fingerprint are unchanged. It retains the frontend reservation and verifies the new managed terminal, loopback listener and HTTPS certificate before publishing. Recovery makes at most three start attempts per new daemon, with increasing delays. An uncertain start response or unexpected running replacement requires an explicit start rather than adoption.

Use the preview helper's stop operation to durably cancel recovery, including during maintenance. A service observed stopped in the same daemon also remains stopped; recovery does not supervise application crashes. Archived, moved or reconfigured workspaces do not recover automatically. Enabling recovery never revives old stopped reservations. Omit the installer option to preserve existing policy, or use `--no-restore-after-restart` to disable it. Without this option, previews still require explicit start after restart. Container downtime remains downtime; the broker restores service when the container and daemon return.

The consumer checks every ten seconds while the user session is available. It has bounded file sizes, queue batches, command timeouts and reconciliation work. It is not a synchronous process-death firewall: an external process exit or replacement can precede the next check. Use the helper for deliberate stop/restart so route removal precedes process termination. Never run a new unrelated listener on a reserved backend before its route is removed. Unexpected route changes require administrator review and are never evicted.

Only `ready` receipts contain usable URLs after certificate-validating HTTPS and HTTP checks. Browser rendering, Web Crypto, clipboard permissions and application origin checks are separate acceptance checks. HTTPS adds neither application authentication nor tailnet authorization. Keep direct listeners' forwarded-header trust disabled and preserve explicit bind scope. Tailscale Serve supports WebSocket upgrades; frameworks with explicit HMR client origins must use the reserved HTTPS origin and WSS.

`https-preview.py WORKSPACE_ID SERVICE HTTPS_PORT` remains an administrator compatibility entry point using the same policy, ledger and lock. Never use `serve reset`, enable Funnel or replace another mapping to claim a port.

## Dedicated previews hostname

By default the native broker publishes previews from the Mac's own Tailscale node, so a preview link shares the interface's hostname and differs only by port. To give previews their own hostname, run a second Tailscale node for them and point the broker at it.

1. Get standalone `tailscaled` and `tailscale` binaries at the same version as the installed Tailscale. The macOS app bundle does not include them.
2. Start the node as a login agent. It runs in userspace networking mode with its own state and socket, needs no administrator rights and leaves the system Tailscale alone:

   ```sh
   python3 -B install-previews-node.py --deployment "$HOME/.local/share/vorteo-previews-node" \
     --tailscaled /path/to/tailscaled --tailscale /path/to/tailscale --hostname previews
   ```

   It prints the socket path and, the first time, the `tailscale up` command that produces a sign-in link. Authorize the device in your tailnet. Decide whether its key should expire; an expired key takes every preview offline until you sign in again.

3. Stop every preview, then reinstall the native broker with the socket and the one-time move flag:

   ```sh
   python3 -B install-native-https-broker.py ... --tailscale /path/to/tailscale \
     --tailscale-socket "$HOME/.local/share/vorteo-previews-node/tailscaled.sock" --move-previews-node
   ```

   The installer pins the new node's identity and access scope. It makes the switch while holding the broker's own lock, so a queued start cannot be published on the old node in between. It refuses the move while a preview is running, while the old node no longer matches what the broker was pinned to, or while that node still publishes a port the broker owns. Reservations that name the old hostname are removed and written again as previews start.

4. Start previews again. Ports are kept; the hostname in each link changes, so links shared before the move stop working.

The tailnet policy must let your devices reach the new node on the preview port range. The Previews comment frame and pairing page allow only the exact origins the broker reserved, so the review toolbar keeps working on the new hostname and no other port on either hostname is treated as a preview. The node's directory and state must be owned by you with mode 0700, and its socket must be yours; both installers refuse otherwise. Remove the node with `install-previews-node.py --deployment … --tailscaled … --uninstall` after moving the broker back.

## When the tailnet access scope changes

The broker pins a hash of its node's packet filter and refuses every operation with "Tailnet access scope changed; administrator review required" when it differs. The filter lists the address of each device allowed to reach the node, so the hash changes whenever a device joins or leaves the tailnet, not only when the policy is edited. Previews already published stay reachable; nothing can start, stop or report status until the scope is reviewed.

If the change was a device that should not stay, remove it from the tailnet and the broker recovers on its next run. To accept the new scope on the same node, rerun the native installer with its existing arguments and `--accept-access-scope`. It runs under the broker's lock, refuses if the node itself differs, and prints what it accepted as grants added and removed. A grant is one source reaching one destination with its ports and protocols, shown with device names, so a source that gains ports is reported even when the set of sources is unchanged. An install that predates this record prints every current grant, and a changed hash with no grant difference prints the raw rules and says so. Reserved preview origins are kept, so running previews and their review toolbar are unaffected. Read that output before relying on the broker again.

Adding the dedicated previews node is itself such a change for the old node. A move to the new node checks that the old node is still the same node and publishes none of the broker's ports; it does not require the old node's scope to be unchanged.

## Broker rollback

Stop each broker-managed preview with the helper when its process may stop. This removes and verifies only its owned mapping, and keeps the frontend reservation. For a capability-only rollback that preserves processes, run `python3 uninstall-https-broker.py` from the trusted deployment directory. It unloads this instance's owned login job, verifies each exact route before removal and disables request handling without resetting Tailscale or touching unrelated mappings. Keep the helper's environment loader and origin files for already-wrapped commands. Restore backed-up recovery code/configuration only after checking that its container identities still match. Do not restore stale whole-home or whole-Tailscale state.

An awake, logged-in Mac and available Docker are prerequisites. FileVault unlock, login and host wake are not supplied by this broker. Installation or recovery does not authorize restarting Vorteo, Docker or unrelated services.

## Backup and replacement

Coordinate active work and announce immediately before interruption. Pause recovery, preserve deployment configuration and exact image references, stop production with its configured grace period, then take a consistent home and Tailscale-state backup. Keep the old stopped container and image for rollback. Never run two daemons against the same persistent home.

Recreate with the reviewed candidate, preserving mounts, environment, accounts and persistent web directory. Verify daemon health, node identity, provider catalogs, GitHub identity and repository discovery, served release, preview restoration and physical-device access. Rollback means stopping the replacement before starting the retained old container with its saved configuration. Keep recovery paused while the old container serves. Do not remove volumes, prune rollback artifacts or unenroll host Tailscale as part of cleanup.

Use focused tests with disposable state. `python3 -B test_host_recovery.py` verifies bounded recovery behavior without touching Docker. Record installation-specific test results privately.
