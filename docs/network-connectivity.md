# Installation network checks

Baseline the operator's browser-to-Host connection on every installation. Repeat at least daily through the existing Mechanic or Optimizer heartbeat, and after a network change or reported disconnect. Keep the last check time and result in that thread's journal; hourly reviews reuse today's result unless something changed. Do not create another schedule.

Identify three paths separately: PWA assets, the Host WebSocket, and provider internet requests. A fast page load does not prove a healthy WebSocket. Use connection configuration and recent disconnect logs to identify the actual Host endpoint and active operator peer. If that identity is unavailable, ask rather than probing arbitrary tailnet devices. If the transport does not use Tailscale, record that and check its actual route.

## Bounded read-only baseline

Use the installed Tailscale CLI on the Host. On macOS it may be at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Check its help because flags vary by version.

1. Read `tailscale status --json`. Select the known operator peer and retain only its online status, current endpoint and relay fields. A home relay listed in status does not prove traffic is relayed.
2. Run `tailscale ping --c 3 --timeout 3s <known-peer>`. Record each observed path and latency. Discovery may initially use DERP and then become direct. Report persistent DERP, peer relay, direct or unreachable separately. Discovery responses do not prove application authorization or application packet loss.
3. For an unexpected relay path, run `tailscale netcheck` once with an outer process timeout of 30 seconds. Its UDP and NAT results describe this endpoint only. UDP success does not prove peer reachability. Report timeout or errors as inconclusive.
4. Compare the selected direct endpoint with the Host's interfaces, subnet masks and route table. A direct public endpoint proves a direct connection, but does not prove a LAN path. Where authorized peer access exists, collect the same evidence there. Compare physical gateway and peer reachability with at most three ICMP probes, using the platform's per-probe timeout. ICMP failure alone does not prove UDP is blocked.

Keep full status, network maps and machine addresses out of Git and public reports. Never dump a network map: it can contain keys and the entire peer inventory. If endpoint discovery requires it, filter in-process to the known peer's addresses and endpoints and discard all other fields. Do not collect credentials, packet payloads, SSIDs or unrelated peers. Store only the minimum diagnostic evidence outside Git.

## When nearby devices remain relayed

Check the advertised local addresses and actual routes first. Devices in the same room or on the same SSID may use separate guest networks, nested routers, hotspots or isolated VLANs. Different subnets require working routing and policy between them; matching subnets still do not rule out client isolation. An advertised address can be stale, so confirm it on the peer before declaring a cause.

Then inspect both endpoints' UDP reachability, firewall policy, exit-node LAN access policy and, on macOS, Local Network permission for Tailscale or its extension. A [reported macOS permission issue](https://github.com/tailscale/tailscale/issues/21055) can leave the extension named IPNExtension in the permission prompt. This is a diagnostic candidate, not proof of the local cause. See Tailscale's [connection types](https://tailscale.com/docs/reference/connection-types) and [firewall guidance](https://tailscale.com/docs/integrations/firewalls).

Recommend the smallest remedy supported by both peers' evidence. Do not disable security controls, open ports, alter ACLs, change Wi-Fi, reset permissions, disconnect Tailscale or restart services during a maintenance check. Ask for the missing access or operator decision. Route installation changes to Builds and preserve tracked lifecycle approvals. A local relay is a separate fallback design; it does not repair a blocked direct LAN path.

## Acceptance and reporting

After an authorized remedy, repeat the same bounded probes. Require a direct endpoint verified against LAN routes before claiming local connectivity. Check the real PWA-to-Host session for reconnects over an agreed observation window and compare latency with the baseline. Keep application slowness investigations separate when the transport improves but slow provider requests remain.

Report a changed or actionable finding with the observed route, latency range, uncertainty, proposed action and verification. Update the existing checklist item. Keep healthy and unchanged checks quiet. If peer access is missing, retain the diagnosis as incomplete while continuing independent maintenance work.

## Durable instructions

The shared network guidance in `network-maintenance.ts` feeds both the standalone Optimizer charter and the system project's Factory Mechanic charter. Non-system Factory projects do not gain installation checks. These are shipped source instructions; installing source and confirming the effective agent prompt are separate acceptance steps. Existing customized role additions must pass Factory's charter review process. Only the operator changes project instructions; a repository edit or journal note does not update every running installation.
