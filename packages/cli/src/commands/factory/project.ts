import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  factoryProjectConfigure,
  factoryProjectDisable,
  factoryProjectEnable,
  factoryProjectGet,
  factoryProjectInstructionsAcknowledge,
  factoryProjectInstructionsGet,
  factoryProjectInstructionsPropose,
  factoryProjectInstructionsResolve,
  factoryProjectInstructionsSet,
  factoryProjectPause,
  factoryProjectResume,
  factoryProjectStatusSet,
  ProjectFactoryRoleIdSchema,
  type ProjectFactoryInstructions,
  type ProjectFactoryRoleId,
  type ProjectFactoryState,
} from "@getpaseo/server/factory-project";
import {
  withOutput,
  type CommandOptions,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

type Client = Awaited<ReturnType<typeof connectToDaemon>>;
interface Rpc<Output> {
  name: string;
  output: { parse(value: unknown): Output };
}

const stateSchema: OutputSchema<ProjectFactoryState> = {
  idField: "projectId",
  columns: [],
  renderHuman: (result) => {
    const state = result.data as ProjectFactoryState;
    const rows = state.roles.map((role) =>
      [
        role.title,
        role.role,
        role.agentId ?? "-",
        role.workspaceId ?? "-",
        role.heartbeat ? `${role.heartbeat.cron}${role.heartbeat.paused ? " (paused)" : ""}` : "-",
        role.launch.provider
          ? `${role.launch.provider}${role.launch.profileId ? `/${role.launch.profileId}` : ""}`
          : "default",
        `r${role.instructions.revision}${role.instructions.review === "none" ? "" : ` ${role.instructions.review}`}`,
        role.status?.line ?? "",
      ].join("\t"),
    );
    return [
      `Project: ${state.projectId}`,
      `Factory: ${state.state}${state.reason ? ` (${state.reason})` : ""}`,
      `Repository: ${state.repository ?? "none"}`,
      `Worker profile: ${state.workers.workerProfileId ?? "default"}`,
      `Reviewer profile: ${state.workers.reviewerProfileId ?? "default"}`,
      "",
      ["ROLE", "ID", "AGENT", "WORKSPACE", "HEARTBEAT", "LAUNCH", "INSTRUCTIONS", "STATUS"].join(
        "\t",
      ),
      ...rows,
    ].join("\n");
  },
};

const instructionsSchema: OutputSchema<ProjectFactoryInstructions> = {
  idField: "role",
  columns: [],
  renderHuman: (result) => {
    const value = result.data as ProjectFactoryInstructions;
    const proposal = value.review.proposal;
    return [
      `Role: ${value.role}`,
      `Revision: ${value.revision}${value.updatedAt ? ` (${value.updatedAt})` : ""}`,
      `Review: ${value.review.status}`,
      `Charter version: ${value.charterVersion}`,
      `Reviewed against: ${value.basedOn?.charterVersion ?? "none"}`,
      "",
      "Project instructions:",
      value.additions || "(none)",
      ...(proposal
        ? ["", `Proposal (${proposal.proposedAt}): ${proposal.rationale}`, proposal.text]
        : []),
    ].join("\n");
  },
};

async function call<Output>(client: Client, rpc: Rpc<Output>, input: unknown): Promise<Output> {
  if (client.getLastServerInfoMessage()?.features?.plugins !== true)
    throw { code: "DAEMON_UPDATE_REQUIRED", message: "The selected daemon lacks plugin RPC." };
  return rpc.output.parse(await client.invokePluginRpc("factory", rpc.name, input));
}

async function withClient<T>(
  options: CommandOptions,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function single<T>(data: T, schema: OutputSchema<T>): SingleResult<T> {
  return { type: "single", data, schema };
}

function parseRole(value: string): ProjectFactoryRoleId {
  const role = ProjectFactoryRoleIdSchema.safeParse(value);
  if (!role.success)
    throw {
      code: "INVALID_ROLE",
      message: `Unknown role ${value}. Use one of: ${ProjectFactoryRoleIdSchema.options.join(", ")}.`,
    };
  return role.data;
}

/** `--adopt factory-intake=<agentId>`, repeatable. */
function collectAdopt(value: string, previous: Record<string, string> = {}) {
  const [role, agentId] = value.split("=");
  if (!role || !agentId) throw { code: "INVALID_ADOPT", message: "Use --adopt <role>=<agentId>." };
  return { ...previous, [parseRole(role)]: agentId };
}

/** "none" clears a configured value back to the default. */
function optionalId(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  return value === "none" ? null : value;
}

async function readText(file: unknown): Promise<string> {
  if (typeof file !== "string")
    throw { code: "MISSING_FILE", message: "Pass the text with --file <path>." };
  return readFile(file, "utf8");
}

function stateCommand(
  name: string,
  description: string,
  rpc: Rpc<ProjectFactoryState>,
  input: (projectId: string, options: CommandOptions) => unknown,
  configure: (command: Command) => Command = (command) => command,
): Command {
  const command = configure(
    new Command(name)
      .description(description)
      .argument("<project-id>", "Exact native project identity")
      .allowExcessArguments(false),
  );
  return addJsonAndDaemonHostOptions(command).action(
    withOutput(async (projectId: string, options: CommandOptions, _command: Command) =>
      withClient(options, async (client) =>
        single(await call(client, rpc, input(projectId, options)), stateSchema),
      ),
    ),
  );
}

export function createFactoryProjectCommand(): Command {
  const project = new Command("project").description(
    "Turn a project's Factory on, off, pause it and configure its roles",
  );
  project.addCommand(
    stateCommand("show", "Show the project's Factory and its roles", factoryProjectGet, (id) => ({
      projectId: id,
    })),
  );
  project.addCommand(
    stateCommand(
      "enable",
      "Turn Factory on, creating or adopting its role agents",
      factoryProjectEnable,
      (id, options) => ({
        projectId: id,
        repository: options.repository,
        ...(options.adopt ? { adopt: options.adopt } : {}),
      }),
      (command) =>
        command
          .requiredOption("--repository <owner/name>", "GitHub repository the Factory serves")
          .option("--adopt <role=agentId>", "Bind an existing agent to a role", collectAdopt),
    ),
  );
  project.addCommand(
    stateCommand("pause", "Pause every role heartbeat", factoryProjectPause, (id) => ({
      projectId: id,
    })),
  );
  project.addCommand(
    stateCommand("resume", "Resume every role heartbeat", factoryProjectResume, (id) => ({
      projectId: id,
    })),
  );
  project.addCommand(
    stateCommand(
      "disable",
      "Turn Factory off; workspaces, agents and history stay",
      factoryProjectDisable,
      (id) => ({ projectId: id }),
    ),
  );
  project.addCommand(
    stateCommand(
      "configure",
      "Set a role's provider and profile, or the worker and reviewer profiles (none clears)",
      factoryProjectConfigure,
      (id, options) => {
        const input: Record<string, unknown> = { projectId: id };
        if (typeof options.role === "string") input.role = parseRole(options.role);
        for (const [key, option] of [
          ["provider", "provider"],
          ["profileId", "profile"],
          ["workerProfileId", "workerProfile"],
          ["reviewerProfileId", "reviewerProfile"],
        ] as const) {
          const value = optionalId(options[option]);
          if (value !== undefined) input[key] = value;
        }
        return input;
      },
      (command) =>
        command
          .option("--role <role-id>", "Role whose launch to set")
          .option("--provider <provider>", "Provider for the role")
          .option("--profile <profile-id>", "Profile for the role")
          .option("--worker-profile <profile-id>", "Profile the Foreman gives workers")
          .option("--reviewer-profile <profile-id>", "Profile the Foreman gives reviewers"),
    ),
  );

  const status = new Command("status").description("Set a role's one-line status");
  status.addCommand(
    addJsonAndDaemonHostOptions(
      new Command("set")
        .description("Set or, with an empty line, clear a role's status line")
        .argument("<project-id>", "Exact native project identity")
        .argument("<role-id>", "Role whose status to set")
        .argument("<line>", "At most 120 characters")
        .allowExcessArguments(false),
    ).action(
      withOutput(
        async (
          projectId: string,
          role: string,
          line: string,
          options: CommandOptions,
          _command: Command,
        ) =>
          withClient(options, async (client) =>
            single(
              await call(client, factoryProjectStatusSet, {
                projectId,
                role: parseRole(role),
                line,
              }),
              stateSchema,
            ),
          ),
      ),
    ),
  );
  project.addCommand(status);
  project.addCommand(createInstructionsCommand());
  return project;
}

function instructionsCommand(
  name: string,
  description: string,
  run: (
    client: Client,
    target: { projectId: string; role: ProjectFactoryRoleId },
    options: CommandOptions,
  ) => Promise<ProjectFactoryInstructions>,
  configure: (command: Command) => Command = (command) => command,
): Command {
  const command = configure(
    new Command(name)
      .description(description)
      .argument("<project-id>", "Exact native project identity")
      .argument("<role-id>", "Factory role")
      .allowExcessArguments(false),
  );
  return addJsonAndDaemonHostOptions(command).action(
    withOutput(
      async (projectId: string, role: string, options: CommandOptions, _command: Command) =>
        withClient(options, async (client) =>
          single(
            await run(client, { projectId, role: parseRole(role) }, options),
            instructionsSchema,
          ),
        ),
    ),
  );
}

function createInstructionsCommand(): Command {
  const instructions = new Command("instructions").description(
    "Read and edit a role's project instructions",
  );
  const current = (client: Client, target: { projectId: string; role: ProjectFactoryRoleId }) =>
    call(client, factoryProjectInstructionsGet, target);
  instructions.addCommand(
    instructionsCommand(
      "show",
      "Show the shipped charter version, instructions and review",
      current,
    ),
  );
  instructions.addCommand(
    instructionsCommand(
      "set",
      "Save new project instructions from a file",
      async (client, target, options) =>
        call(client, factoryProjectInstructionsSet, {
          ...target,
          additions: await readText(options.file),
          expectedRevision: (await current(client, target)).revision,
        }),
      (command) => command.requiredOption("--file <path>", "File with the instructions"),
    ),
  );
  instructions.addCommand(
    instructionsCommand(
      "propose",
      "Propose revised instructions for the operator to accept or dismiss",
      async (client, target, options) =>
        call(client, factoryProjectInstructionsPropose, {
          ...target,
          text: await readText(options.file),
          rationale: options.rationale,
        }),
      (command) =>
        command
          .requiredOption("--file <path>", "File with the proposed instructions")
          .requiredOption("--rationale <text>", "Why each change is needed"),
    ),
  );
  instructions.addCommand(
    instructionsCommand(
      "acknowledge",
      "Mark the instructions reviewed against the current charter, unchanged",
      (client, target) => call(client, factoryProjectInstructionsAcknowledge, target),
    ),
  );
  instructions.addCommand(
    instructionsCommand(
      "resolve",
      "Accept or dismiss the pending proposal",
      async (client, target, options) => {
        if (Boolean(options.accept) === Boolean(options.dismiss))
          throw { code: "INVALID_RESOLVE", message: "Pass exactly one of --accept or --dismiss." };
        const fresh = await current(client, target);
        const proposedAt = fresh.review.proposal?.proposedAt;
        return call(client, factoryProjectInstructionsResolve, {
          ...target,
          accept: Boolean(options.accept),
          expectedRevision: fresh.revision,
          ...(options.accept && proposedAt ? { proposedAt } : {}),
        });
      },
      (command) =>
        command
          .option("--accept", "Apply the proposal as a new revision")
          .option("--dismiss", "Keep the current instructions"),
    ),
  );
  return instructions;
}
