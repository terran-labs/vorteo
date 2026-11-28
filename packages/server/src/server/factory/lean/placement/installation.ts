import { dirname, join } from "node:path";
import { z } from "zod";
import { ExecutionInstallationSchema } from "@getpaseo/protocol/execution-installation";
import { readPrivateBootstrapConfiguration } from "../../../execution-installation/coordinator-bootstrap-private-configuration.js";
import {
  readFactoryHostHome,
  readFactoryHostServerId,
} from "../machines/machine-identity-installation.js";

const descriptor = z.object({ public: ExecutionInstallationSchema, container: z.object({}) });

export interface BoundDevInstallation {
  installationId: string;
  hostServerId: string;
  devServerId: string;
}

/** Resolve a destination from the installed Host's private record. The saved connection is checked separately. */
export async function readBoundDevInstallation(input: {
  paseoHome: string;
  serverId: string;
  environment: "host" | "container" | undefined;
  clientConfigFile: string | undefined;
}): Promise<BoundDevInstallation | null> {
  const uid = process.getuid?.();
  if (
    input.environment !== "host" ||
    !input.clientConfigFile ||
    uid === undefined ||
    process.env.PASEO_NETWORK_MODE
  )
    return null;
  const root = dirname(input.clientConfigFile);
  try {
    if (
      (await readFactoryHostHome(root)) !== input.paseoHome ||
      (await readFactoryHostServerId(input.paseoHome)) !== input.serverId
    )
      return null;
    const record = descriptor.parse(
      readPrivateBootstrapConfiguration(join(root, "coordinator.json"), uid),
    ).public;
    const hosts = record.environments.filter((row) => row.kind === "host");
    const containers = record.environments.filter((row) => row.kind === "container");
    if (hosts.length !== 1 || containers.length !== 1) return null;
    const [host] = hosts;
    const [dev] = containers;
    if (host.serverId !== input.serverId || dev.serverId === host.serverId) return null;
    return {
      installationId: record.installationId,
      hostServerId: host.serverId,
      devServerId: dev.serverId,
    };
  } catch {
    // An unavailable or replaced installation record cannot select a remote runner.
    return null;
  }
}
