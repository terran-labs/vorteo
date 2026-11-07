/** The client kinds an installation client config names; see the coordinator's agent tokens. */
export type InstallationClientKind = "host-agent" | "container-agent";

/** Matches `access.gateRoute.authority`'s port: the coordinator's configured listen port. */
const GATE_ROUTE_PORT = /^\d{4,5}$/;

/**
 * Whether an installation client may use `origin` to reach the coordinator. The origin must
 * be bare (scheme, host and port only) and use HTTPS, except where nothing crosses an
 * untrusted network:
 *
 * - Host loopback, at `http://localhost` or `http://127.0.0.1`.
 * - A gate-mode Dev's route, at exactly `http://host.docker.internal:<listenPort>` from a
 *   container client while `PASEO_NETWORK_MODE` is `gate`. Only the gate resolves that name,
 *   so the request crosses Dev's private network to the gate and on to the Host. Dev does
 *   not know the listen port; the gate's `routes` allowlist and the coordinator's
 *   `access.gateRoute` authority enforce it. See docs/execution-installation.md.
 *
 * The managed Dev client and settings admission share this rule. `scripts/installation-agent.mjs`
 * keeps its own copy because it is installed into Dev without the server package.
 */
export function installationClientOriginAllowed(
  value: string,
  kind: InstallationClientKind,
  env: NodeJS.ProcessEnv,
): boolean {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (origin.origin !== value) return false;
  if (origin.protocol === "https:") return true;
  if (origin.protocol !== "http:") return false;
  if (origin.hostname === "localhost" || origin.hostname === "127.0.0.1") return true;
  return (
    origin.hostname === "host.docker.internal" &&
    GATE_ROUTE_PORT.test(origin.port) &&
    kind === "container-agent" &&
    env.PASEO_NETWORK_MODE === "gate"
  );
}
