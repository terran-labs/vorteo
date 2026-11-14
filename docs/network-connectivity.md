# Installation network checks

Baseline the operator's browser-to-Host connection on every installation. Repeat at least daily through the existing Mechanic or Optimizer heartbeat, and after a network change or reported disconnect. Keep the last check time and result in that thread's journal; hourly reviews reuse today's result unless something changed. Reuse an unchanged persistent-relay diagnosis rather than repeating the deeper two-peer investigation daily. Do not create another schedule.

Identify three paths separately: PWA assets, the Host WebSocket, and provider internet requests. A fast page load does not prove a healthy WebSocket. Use connection configuration and recent disconnect logs to identify the actual Host endpoint and active operator peer. If that identity is unavailable, ask rather than probing arbitrary tailnet devices. If the transport does not use Tailscale, record that and check its actual route.

## Bounded read-only baseline

Use the installed Tailscale CLI on the Host. On macOS it may be at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Check its help because flags vary by version.

1. Establish an explicit known-peer allowlist before running diagnostics. Pipe `tailscale status --json` directly into an in-process filter that selects only allowlisted peers and emits a redacted summary. Never print full status and select the peer afterward. Keep any selected endpoint and relay fields needed for route verification only in restricted local scratch. A home relay listed in status does not prove traffic is relayed.
2. Run `tailscale ping --c 3 --timeout 3s <known-peer>`. Capture both output streams in restricted local scratch and emit only the redacted route category and latency. Discovery may initially use DERP and then become direct. Report persistent DERP, peer relay, direct or unreachable separately. Discovery responses do not prove application authorization or application packet loss.
3. For an unexpected relay path, run `tailscale netcheck` once with an outer process timeout of 30 seconds. Its UDP and NAT results describe this endpoint only. UDP success does not prove peer reachability. Report timeout or errors as inconclusive.
4. Compare the selected direct endpoint with the Host's interfaces, subnet masks and route table. A direct public endpoint proves a direct connection, but does not prove a LAN path. Where authorized peer access exists, collect the same evidence there. Compare physical gateway and peer reachability with at most three ICMP probes, using the platform's per-probe timeout. ICMP failure alone does not prove UDP is blocked.

Prepare the filtering and redaction step before running any probe. Every command, including status, ping, netcheck, route inspection and ICMP probes, must filter stdout and stderr before tool output or history. Use only the known-peer allowlist; do not echo commands containing peer identifiers or enable shell tracing. If safe redaction is unavailable, report the check as unavailable instead of printing raw diagnostics. This runbook is agent guidance; it does not provide code-enforced filtering.

Every report, journal, checklist and tool output must omit machine addresses, hostnames and peer identities. Report redacted route categories (direct, local, DERP, peer relay, unreachable or unknown), latency and non-identifying diagnostic conclusions. Keep exact endpoint evidence only in restricted local scratch outside Git, with owner-only directory and file permissions. Keep full status and network maps out of output and history. Never dump a network map: it can contain keys and the entire peer inventory. If endpoint discovery requires it, filter in-process to allowlisted peers' addresses and endpoints, write that evidence only to restricted local scratch and discard all other fields before output. Do not collect credentials, packet payloads, SSIDs or unrelated peers. Retain only the minimum endpoint evidence required for diagnosis in that restricted scratch location; remove it when no longer needed.

## When nearby devices remain relayed

Check the advertised local addresses and actual routes first. Devices in the same room or on the same SSID may use separate guest networks, nested routers, hotspots or isolated VLANs. Different subnets require working routing and policy between them; matching subnets still do not rule out client isolation. An advertised address can be stale, so confirm it on the peer before declaring a cause.

Then inspect both endpoints' UDP reachability, firewall policy, exit-node LAN access policy and, on macOS, Local Network permission for Tailscale or its extension. A [reported macOS permission issue](https://github.com/tailscale/tailscale/issues/21055) can leave the extension named IPNExtension in the permission prompt. This is a diagnostic candidate, not proof of the local cause. See Tailscale's [connection types](https://tailscale.com/docs/reference/connection-types) and [firewall guidance](https://tailscale.com/docs/integrations/firewalls).

Recommend the smallest remedy supported by both peers' evidence. Do not disable security controls, open ports, alter ACLs, change Wi-Fi, reset permissions, disconnect Tailscale or restart services during a maintenance check. Ask for the missing access or operator decision. Route installation changes to Builds and preserve tracked lifecycle approvals. A local relay is a separate fallback design; it does not repair a blocked direct LAN path.

## Acceptance and reporting

After an authorized remedy, repeat the same bounded probes. Require a direct endpoint verified against LAN routes before claiming local connectivity. Check the real PWA-to-Host session for reconnects over an agreed observation window and compare latency with the baseline. Keep application slowness investigations separate when the transport improves but slow provider requests remain.

Report a changed or actionable finding with only a redacted route category, latency range and non-identifying uncertainty, proposed action and verification. Update the existing checklist item. Keep healthy and unchanged checks quiet. If peer access is missing, retain the diagnosis as incomplete while continuing independent maintenance work.

## Durable instructions

The shared network guidance in `network-maintenance.ts` feeds both the standalone Optimizer charter and the system project's Factory Mechanic charter. Non-system Factory projects do not gain installation checks. These are shipped source instructions; installing source and confirming the effective agent prompt are separate acceptance steps. Existing customized role additions must pass Factory's charter review process. Only the operator changes project instructions; a repository edit or journal note does not update every running installation.
