import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { installationClientOriginAllowed } from "./client-origin.js";

const PairedClientSchema = z.object({
  kind: z.literal("container-agent"),
  origin: z.url(),
  token: z.string().min(1),
});

interface ManagedClientInput {
  configuredPath?: string;
  managedWorker: boolean;
  /** The worker's PASEO_HOME. The Dev image's daemon uses `~/.paseo`; repo dev scripts do not. */
  paseoHome?: string;
  environment?: "host" | "container";
  platform: NodeJS.Platform;
  homeDir: string;
  uid: number | undefined;
  /** The worker's environment; `PASEO_NETWORK_MODE` decides whether the gate route applies. */
  env: NodeJS.ProcessEnv;
}

/** Older managed supervisors did not inherit the client installed by pairing. */
export function resolveManagedInstallationClient(input: ManagedClientInput): string | undefined {
  if (input.configuredPath) return input.configuredPath;
  // The image daemon was paired after its launcher started when the client file appeared later
  // (pairing runs inside a running container), so it may lack the export just as an older
  // managed supervisor did. Its home holds the pairing binding; other workers stay standalone.
  const pairedHome =
    input.managedWorker ||
    (input.paseoHome !== undefined &&
      path.resolve(input.paseoHome) === path.join(input.homeDir, ".paseo"));
  const pairedDev = pairedHome && input.platform === "linux" && input.environment === "container";
  if (!pairedDev) return undefined;
  const file = path.join(input.homeDir, ".local/share/vorteo-installation-client/client.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== input.uid || (stat.mode & 0o077) !== 0 || stat.size > 65536)
      throw new Error("Invalid paired client file");
    const config = PairedClientSchema.parse(JSON.parse(readFileSync(descriptor, "utf8")));
    if (!installationClientOriginAllowed(config.origin, config.kind, input.env))
      throw new Error("Invalid paired client origin");
    return file;
  } catch {
    throw new Error(
      "The paired Dev installation client is missing or invalid. Repair its managed installation client before starting the daemon.",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
