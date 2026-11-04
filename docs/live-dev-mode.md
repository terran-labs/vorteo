# Live dev mode

Every installation has a delivery mode. **Reliable** is the default and serves the published static interface. **Live dev** serves the interface from the Expo web dev server running in a persistent source checkout on Host, so an edit reaches the owner's open tab through Fast Refresh in seconds. Only the owner can change the mode, in Installation settings.

Live dev trades provenance for speed. In Reliable mode every served byte traces to a published commit. In Live dev mode the owner's browser runs whatever the live checkout contains right now, including uncommitted edits by Host agents. Those agents already run as the owner's macOS user, so this adds no new privilege, but it removes the publication gate between their edits and the owner's authenticated browser. Dev container agents cannot reach the live checkout: it lives on Host, outside guest-writable mounts.

## What serves the interface

The coordinator serves the interface and Installation controls, so live mode lives in the coordinator.

- **State.** The owner's choice is stored in `<stateDir>/live-dev.json` as `{mode, revision, changedAt}`. It is owner state, not coordinator configuration, so switching modes needs no configuration change or restart. Owner routes `POST /api/installation/owner/live-dev/query` and `/change` (`{expectedRevision, mode}`) read and change it behind the existing owner session check. A stale revision is refused.
- **Paths.** The live checkout is `<host>/live/source`, beside `host/releases`, derived from `deployment.hostReleaseLink`. An installation without that link reports live mode unavailable. The checkout is a Git worktree of the installation's source repository on branch `live/main`, so its commits are visible to Builds without a push.
- **Dev server.** While the mode is Live dev, the coordinator supervises one child: `expo start --web --localhost` in the checkout's `packages/app`, on a loopback port it chooses, with `PASEO_LIVE_PREVIEW_ORIGIN` and `EXPO_PACKAGER_PROXY_URL` set to the installation's public origin. The repository's Expo patch then binds loopback and rejects any Host or Origin other than that origin or loopback. The coordinator writes a pidfile, restarts a crashed child with backoff and logs to `<stateDir>/live-dev/metro.log`. Switching to Reliable stops the child and verifies it exited. The public origin must be a `*.ts.net` HTTPS origin, which the patch requires; other origins report live mode unavailable.
- **Proxy.** The web UI middleware sends a request to the dev server only when the mode is Live dev, the dev server is ready, the browser holds a valid owner session for this origin, and the browser has not chosen the safe interface. Everyone else gets the static interface. Only these paths pass: the page itself, `*.bundle` and `*.map` under `/node_modules/` and the app root, `/assets/`, `/_expo/static/`, `/symbolicate`, and the `/hot` WebSocket. Every other Metro path is refused, including the editor launchers (`/open-stack-frame`, `/open-url`, `/_expo/open`), the debugger (`/inspector`, `/json`, `/_expo/debugger`) and `/message`. The proxied HTML gets the same installation hint injection as the static page.

## The safe interface

A broken live edit must never lock the owner out of the interface they use to fix it.

- `/?interface=safe` sets a session cookie that serves the static interface for this browser until `/?interface=live` clears it. The static interface is the last release the coordinator installed, which live edits never touch.
- If the dev server is stopped, starting or not answering within five seconds, the page falls back to the static interface automatically.
- The coordinator injects a small **Live dev** marker into the proxied HTML, outside the app bundle, with a **Safe interface** link. Because it is not part of the live code, it survives a bundle that fails to compile.
- From the safe interface the owner can switch the installation back to Reliable in Installation settings.

## Changing the live checkout

`node scripts/live-dev.mjs <command>` is the only supported way to change the live checkout's Git state. Each command takes a short exclusive lock under `<host>/live/lock` and refuses rather than guessing.

- **Tweak.** Agents edit files in the live checkout directly for one-off changes; Fast Refresh shows them immediately. `live-dev claim --by <thread>` records an advisory claim on the files an agent is editing, and `status` shows claims so two agents do not edit the same file at once. `live-dev commit --by <thread> -m <message>` commits the claimed edits on `live/main` and releases the claim.
- **Promote.** `live-dev promote <branch>` merges a task branch into `live/main`. It refuses while unclaimed or another thread's uncommitted edits are present, and aborts on any conflict, leaving the live tree unchanged.
- **Sync.** `live-dev sync` merges `origin/main` into `live/main` under the same rules.
- **Dependencies.** When a commit, promotion or sync changes the lockfile or a workspace `package.json`, the command reinstalls dependencies with the shared cache and asks the coordinator to restart the dev server by writing `<host>/live/restart-request`. The coordinator only restarts its own child in response.
- **Delivery.** `live/main` reaches GitHub `main` through Builds' usual pull request, the same day. Builds merges `origin/main` back with `live-dev sync` afterwards.

## Fast-track daemon restarts

Daemon, protocol and server changes still restart the Host daemon through the tracked lifecycle workflow, with its approval policy and finish-turns hold. In live mode the update builds from a copy-on-write clone of the live checkout instead of a fresh archive and clean install: dependencies, TypeScript incremental build information and the previous output come along, the dependency rebuild runs only when the lockfile changed, and the web export is skipped because the interface is already live. A failed build leaves the running release selected. This needs the managed source updater, so it follows the managed delivery conversion that Builds is preparing.

## Compatibility

New owner routes and the `liveDev` capability field are additions. Older interfaces never call them and see the static interface. Reliable mode behaves exactly as before. The state file is absent on existing installations, which reads as Reliable.
