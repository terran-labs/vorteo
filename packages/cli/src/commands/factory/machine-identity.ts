import { Command } from "commander";
import { fileURLToPath } from "node:url";
import type { FactoryMachineIdentity, manageFactoryMachineIdentity } from "@getpaseo/server";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";

const schema: OutputSchema<FactoryMachineIdentity> = {
  idField: "installation",
  columns: [],
  renderHuman: ({ data }) => {
    const { installation, active, pending } = data as FactoryMachineIdentity;
    if ((data as FactoryMachineIdentity).signingDisabled)
      return `Installation: ${installation}\nMachine signing is disabled for this placement.`;
    return [
      `Installation: ${installation}`,
      active
        ? `Active key (${active.fingerprint}):\n${active.publicKey.trimEnd()}`
        : "No active signing key for this placement.",
      ...(pending
        ? [
            `Staged key (${pending.fingerprint}):\n${pending.publicKey.trimEnd()}`,
            "Enroll the staged key as overlapPublicKey in the owner config before activation.",
          ]
        : []),
    ].join("\n");
  },
};

interface HostIdentity {
  paseoHome: string;
  serverId: string;
}
type ReadProject = (host: HostIdentity, projectId: string) => Promise<string>;

async function readHostProject(host: HostIdentity, projectId: string): Promise<string> {
  const [{ connectToDaemon }, { factoryProjectGet }] = await Promise.all([
    import("../../utils/client.js"),
    import("@getpaseo/server/factory-project"),
  ]);
  const client = await connectToDaemon({ target: { kind: "instance", home: host.paseoHome } });
  try {
    if (client.getLastServerInfoMessage()?.serverId !== host.serverId) {
      throw new Error("The installed Host daemon identity does not match its private state.");
    }
    const project = factoryProjectGet.output.parse(
      await client.invokePluginRpc("factory", factoryProjectGet.name, { projectId }),
    );
    if (project.installation !== `${host.serverId}/${projectId}` || !project.repository) {
      throw new Error("Use a Factory project configured on the installed native Host.");
    }
    return project.repository;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runIdentity(
  projectId: string,
  operation: Parameters<typeof manageFactoryMachineIdentity>[0]["operation"],
  options: CommandOptions,
  readProject: ReadProject,
): Promise<SingleResult<FactoryMachineIdentity>> {
  if (process.env.PASEO_HOST || options.host || options.home) {
    throw new Error("Run this command locally against the installed Host daemon home.");
  }
  const {
    manageFactoryMachineIdentity: manage,
    factoryProjectAllowsMachineKeys,
    resolveInstalledFactoryHost,
    verifyFactoryMachineOverlap,
  } = await import("@getpaseo/server");
  const host = await resolveInstalledFactoryHost(fileURLToPath(import.meta.url));
  if (process.env.PASEO_HOME && process.env.PASEO_HOME !== host.paseoHome) {
    throw new Error("The selected home differs from the installed native Host daemon home.");
  }
  const repository = await readProject(host, projectId);
  const data = await manage({
    environment: "host",
    paseoHome: host.paseoHome,
    projectId,
    expectedServerId: host.serverId,
    operation,
    allowsDevSigning: () => factoryProjectAllowsMachineKeys(repository),
    verifyOverlap: (keys) => verifyFactoryMachineOverlap({ repository, ...keys }),
  });
  return { type: "single", data, schema };
}

export function createFactoryMachineIdentityCommand(
  readProject: ReadProject = readHostProject,
): Command {
  const group = new Command("machine").description("Manage this native Host's Factory identity");
  const actions = [
    { name: "show", kind: "show", description: "Show the installation ID and public keys" },
    { name: "generate", kind: "generate", description: "Generate the first Host key if absent" },
    { name: "rotate", kind: "stage", description: "Stage a replacement key for owner enrollment" },
    {
      name: "activate",
      kind: "activate",
      description: "Activate the staged key after enrolling its public key in the owner config",
    },
  ] as const;
  for (const { name, kind, description } of actions) {
    const command = new Command(name)
      .description(description)
      .argument("<project-id>", "The local Host Factory project ID")
      .allowExcessArguments(false);
    if (kind === "activate") {
      command
        .argument("<fingerprint>", "Exact staged key fingerprint")
        .action(
          withOutput<FactoryMachineIdentity, [string, string]>((projectId, fingerprint, options) =>
            runIdentity(projectId, { kind, fingerprint }, options, readProject),
          ),
        );
    } else {
      command.action(
        withOutput<FactoryMachineIdentity, [string]>((projectId, options) =>
          runIdentity(projectId, { kind }, options, readProject),
        ),
      );
    }
    group.addCommand(command);
  }
  return group;
}
