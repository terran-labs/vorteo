import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import {
  factoryProjectClaim,
  factoryProjectClaimRelease,
  factoryProjectConfigure,
  factoryProjectDisable,
  factoryProjectPickAccount,
  ProjectFactoryStageSchema,
  factoryProjectEnable,
  factoryProjectGet,
  factoryProjectInstructionsAcknowledge,
  factoryProjectInstructionsGet,
  factoryProjectInstructionsPropose,
  factoryProjectInstructionsResolve,
  factoryProjectInstructionsSet,
  factoryProjectList,
  factoryProjectPause,
  factoryProjectPauseAll,
  factoryProjectResumeAll,
  PROJECT_FACTORY_DRAIN_REASON,
  factoryProjectResume,
  factoryProjectStatusSet,
  ProjectFactoryRoleIdSchema,
  type ProjectFactoryAccountPick,
  type ProjectFactoryAssignment,
  type ProjectFactoryClaim,
  type ProjectFactoryClaimRelease,
  type ProjectFactoryInstructions,
  type ProjectFactoryList,
  type ProjectFactoryRoleId,
  type ProjectFactoryState,
} from "@getpaseo/server/factory-project";
import {
  withOutput,
  type CommandOptions,
  type ListResult,
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
      ...(state.installation ? [`Installation: ${state.installation}`] : []),
      ...(state.assignment ? [`Role assignment: ${describeAssignment(state.assignment)}`] : []),
      ...(state.workers.plannerProfileId !== undefined
        ? [`Planner profile: ${state.workers.plannerProfileId ?? "default"}`]
        : []),
      ...(state.workers.planning !== undefined
        ? [`Planning: ${state.workers.planning ? "on" : "off"}`]
        : []),
      `Worker profile: ${state.workers.workerProfileId ?? "default"}`,
      `Reviewer profile: ${state.workers.reviewerProfileId ?? "default"}`,
      `Drain: ${state.drain ? `${state.drain.id} (${state.drain.reason}, ${state.drain.pausedAt})` : "none"}`,
      "",
      ["ROLE", "ID", "AGENT", "WORKSPACE", "HEARTBEAT", "LAUNCH", "INSTRUCTIONS", "STATUS"].join(
        "\t",
      ),
      ...rows,
    ].join("\n");
  },
};

function describeAssignment(assignment: ProjectFactoryAssignment): string {
  if (assignment.source === "none") return "no .github/factory.json";
  if (assignment.source !== "file") return `off (${assignment.detail ?? assignment.source})`;
  return `triage ${assignment.triage ?? "none"}, releases ${assignment.releases ?? "none"}`;
}

type ListedProject = ProjectFactoryList["projects"][number];

const listSchema: OutputSchema<ListedProject> = {
  idField: "projectId",
  columns: [
    { header: "PROJECT", field: "projectId" },
    { header: "STATE", field: "state" },
    { header: "REPOSITORY", field: (value) => value.repository ?? "-" },
    { header: "PAUSED", field: "paused" },
    {
      header: "DRAIN",
      field: (value) =>
        value.drain ? `${value.drain.id}: ${value.drain.reason} (${value.drain.pausedAt})` : "-",
    },
  ],
};

function listCommand(
  name: string,
  description: string,
  rpc: Rpc<ProjectFactoryList>,
  input: (options: CommandOptions) => unknown,
  configure: (command: Command) => Command = (command) => command,
): Command {
  const command = configure(new Command(name).description(description).allowExcessArguments(false));
  return addJsonAndDaemonHostOptions(command).action(
    withOutput(
      async (options: CommandOptions, _command: Command): Promise<ListResult<ListedProject>> =>
        withClient(options, async (client) => ({
          type: "list",
          data: (await call(client, rpc, input(options))).projects,
          schema: listSchema,
        })),
    ),
  );
}

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
    listCommand("list", "List every project the Factory knows", factoryProjectList, () => ({})),
  );
  project.addCommand(
    listCommand(
      "pause-all",
      "Pause every project whose Factory is on, recording which ones were paused",
      factoryProjectPauseAll,
      (options) => ({
        reason: typeof options.reason === "string" ? options.reason : PROJECT_FACTORY_DRAIN_REASON,
      }),
      (command) => command.option("--reason <text>", "Why Factory work is draining"),
    ),
  );
  project.addCommand(
    listCommand(
      "resume-all",
      "Resume only the projects pause-all paused",
      factoryProjectResumeAll,
      () => ({}),
    ),
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
          ["plannerProfileId", "plannerProfile"],
          ["workerProfileId", "workerProfile"],
          ["reviewerProfileId", "reviewerProfile"],
        ] as const) {
          const value = optionalId(options[option]);
          if (value !== undefined) input[key] = value;
        }
        if (options.planning !== undefined) input.planning = options.planning === "on";
        return input;
      },
      (command) =>
        command
          .option("--role <role-id>", "Role whose launch to set")
          .option("--provider <provider>", "Provider for the role")
          .option("--profile <profile-id>", "Profile for the role")
          .option("--planner-profile <id|none>", "Profile for issue planning and supervision")
          .addOption(
            new Option("--planning <on|off>", "Plan and supervise new issues").choices([
              "on",
              "off",
            ]),
          )
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
  project.addCommand(createClaimCommand());
  project.addCommand(createPickAccountCommand());
  project.addCommand(createInstructionsCommand());
  return project;
}

const claimSchema: OutputSchema<ProjectFactoryClaim> = {
  idField: "branch",
  columns: [],
  renderHuman: (result) => {
    const value = result.data as ProjectFactoryClaim;
    return [
      `Issue: #${value.issue}`,
      `Branch: ${value.branch}`,
      `Outcome: ${value.outcome}`,
      `Installation: ${value.installation}`,
      `Head: ${value.headSha ?? "none"}`,
      ...(value.marker ? ["", "Marker for the plan comment and PR body:", value.marker] : []),
    ].join("\n");
  },
};

const releaseSchema: OutputSchema<ProjectFactoryClaimRelease> = {
  idField: "branch",
  columns: [],
  renderHuman: (result) => {
    const value = result.data as ProjectFactoryClaimRelease;
    return [
      `Issue: #${value.issue}`,
      `Branch: ${value.branch}`,
      `Outcome: ${value.outcome}`,
      ...(value.archivedAs ? [`Commits kept at: ${value.archivedAs}`] : []),
    ].join("\n");
  },
};

function parseIssue(value: string): number {
  const issue = Number(value);
  if (!Number.isInteger(issue) || issue <= 0)
    throw { code: "INVALID_ISSUE", message: `Use a GitHub issue number, not ${value}.` };
  return issue;
}

function claimArguments(name: string, description: string): Command {
  return addJsonAndDaemonHostOptions(
    new Command(name)
      .description(description)
      .argument("<project-id>", "Exact native project identity")
      .argument("<issue>", "GitHub issue number")
      .allowExcessArguments(false),
  );
}

const pickSchema: OutputSchema<ProjectFactoryAccountPick> = {
  idField: "stage",
  columns: [],
  renderHuman: (result) => {
    const value = result.data as ProjectFactoryAccountPick;
    return [
      `Stage: ${value.stage}`,
      `Profile: ${value.profileId ?? "default"}`,
      describePickedAccount(value),
      ...value.considered.map(
        (item) =>
          `  ${item.provider}: ${item.verdict}${item.remainingPct === null ? "" : ` ${item.remainingPct}%`}`,
      ),
    ].join("\n");
  },
};

function describePickedAccount(value: ProjectFactoryAccountPick): string {
  if (!value.provider) return "Account: none qualifies; use the configured default";
  if (value.bound) return `Account: ${value.provider} (the profile is bound to it)`;
  return `Account: ${value.provider} (${value.remainingPct}% left in its lowest window)`;
}

function createPickAccountCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("pick-account")
      .description(
        "Pick the account a new worker, reviewer or planner starts on, by fresh remaining quota",
      )
      .argument("<project-id>", "Exact native project identity")
      .argument("<stage>", "planner, worker or reviewer")
      .option("--issue <n>", "Issue the agent is for, recorded with the choice")
      .option("--avoid <provider>", "Account to leave out, such as the worker's")
      .allowExcessArguments(false),
  ).action(
    withOutput(
      async (projectId: string, stage: string, options: CommandOptions, _command: Command) => {
        const parsed = ProjectFactoryStageSchema.safeParse(stage);
        if (!parsed.success)
          throw { code: "INVALID_STAGE", message: "Use planner, worker or reviewer." };
        return withClient(options, async (client) =>
          single(
            await call(client, factoryProjectPickAccount, {
              projectId,
              stage: parsed.data,
              ...(typeof options.issue === "string" ? { issue: parseIssue(options.issue) } : {}),
              ...(typeof options.avoid === "string" ? { avoid: options.avoid } : {}),
            }),
            pickSchema,
          ),
        );
      },
    ),
  );
}

function createClaimCommand(): Command {
  const claim = new Command("claim").description(
    "Claim issues so exactly one installation works on each",
  );
  claim.addCommand(
    claimArguments(
      "issue",
      "Claim an issue by creating factory/issue-<n> on GitHub, or report who owns it",
    )
      .option("--keep", "After the owner chose this installation in a conflict, keep the claim")
      .action(
        withOutput(
          async (projectId: string, issue: string, options: CommandOptions, _command: Command) =>
            withClient(options, async (client) =>
              single(
                await call(client, factoryProjectClaim, {
                  projectId,
                  issue: parseIssue(issue),
                  ...(options.keep === true ? { keep: true } : {}),
                }),
                claimSchema,
              ),
            ),
        ),
      ),
  );
  claim.addCommand(
    claimArguments(
      "release",
      "After the owner agrees, archive a stale foreign claim or drop a conflicting own one",
    ).action(
      withOutput(
        async (projectId: string, issue: string, options: CommandOptions, _command: Command) =>
          withClient(options, async (client) =>
            single(
              await call(client, factoryProjectClaimRelease, {
                projectId,
                issue: parseIssue(issue),
              }),
              releaseSchema,
            ),
          ),
      ),
    ),
  );
  return claim;
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
