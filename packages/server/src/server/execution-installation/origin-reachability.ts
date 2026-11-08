import { lookup } from "node:dns/promises";
import { connect } from "node:tls";

const TIMEOUT_MS = 10_000;

/**
 * Null when this installation answers its health check at `origin`, else the evidence. A
 * different installation answering is a failure: the address no longer leads here.
 */
export async function installationHealth(
  origin: string,
  installationId: string,
): Promise<string | null> {
  try {
    const response = await fetch(new URL("/api/installation/health", origin), {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return `health check returned ${response.status}`;
    const body = (await response.json()) as { installationId?: unknown };
    return body.installationId === installationId ? null : "a different installation answered";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Null when DNS resolves the origin's host and it presents a valid certificate for it. */
export async function originCertificate(origin: string): Promise<string | null> {
  const url = new URL(origin);
  try {
    await lookup(url.hostname);
  } catch (error) {
    return `${url.hostname} does not resolve: ${error instanceof Error ? error.message : String(error)}`;
  }
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      timeout: TIMEOUT_MS,
    });
    const done = (result: string | null) => {
      socket.destroy();
      resolve(result);
    };
    // Node verifies the chain and the host name before secureConnect; failures arrive as errors.
    socket.once("secureConnect", () => done(null));
    socket.once("timeout", () => done(`${url.host} did not complete a TLS handshake in time`));
    socket.once("error", (error) => done(`${url.host} has no valid certificate: ${error.message}`));
  });
}
