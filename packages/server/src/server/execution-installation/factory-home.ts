import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import {
  ProjectFactoryListSchema,
  ProjectFactoryRepositorySchema,
  factoryProjectList,
} from "@getpaseo/server/factory-project";
import { z } from "zod";
import { readInstallationClientConfig } from "./settings/admission.js";

/**
 * The Factory home: the one environment of an installation that runs Factory for a repository.
 * The coordinator decides it from both daemons' live Factory lists, so there is no lock to go
 * stale and nothing to migrate. A daemon records Factory as on before it asks, and undoes that
 * when refused, so two environments turning Factory on at once can never both win.
 */
export const FACTORY_HOME_ROUTE = "/api/installation/factory-home";

export const FactoryHomeRequestSchema = z.strictObject({
  repository: ProjectFactoryRepositorySchema,
  /** claim: turning Factory on here. check: Factory is already on here; may it keep running? */
  mode: z.enum(["claim", "check"]),
});
export type FactoryHomeRequest = z.infer<typeof FactoryHomeRequestSchema>;

export const FactoryHomeAnswerSchema = z.object({
  /** home: run here. elsewhere: another environment runs it. unconfirmed: could not tell. */
  outcome: z.enum(["home", "elsewhere", "unconfirmed"]),
  /** The environment that runs Factory for the repository, when known. */
  environment: z.enum(["host", "container"]).nullable(),
  projectId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type FactoryHomeAnswer = z.infer<typeof FactoryHomeAnswerSchema>;

export const FACTORY_HOME_LABELS = { host: "Host", container: "Dev" } as const;

type FactoryList = z.infer<typeof ProjectFactoryListSchema>;

/** Reads one environment's Factory projects; throws when it cannot be read. */
export type ReadFactoryList = (kind: ExecutionEnvironmentKind) => Promise<FactoryList>;

function sameRepository(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

/**
 * Decides one request. The Host is the default home: on a check the Host always keeps running,
 * and Dev stands down when the Host runs the repository too, as after an earlier release let
 * both turn it on. A claim is refused while another environment runs the repository, and while
 * another environment cannot be read: an unreadable Dev may still run the repository, and Dev
 * keeps its last answer while it cannot reach the coordinator, so a claim then could start a
 * second Factory. A Host-only installation has no other environment to read.
 */
export async function decideFactoryHome(
  requester: ExecutionEnvironmentKind,
  request: FactoryHomeRequest,
  environments: readonly ExecutionEnvironmentKind[],
  read: ReadFactoryList,
): Promise<FactoryHomeAnswer> {
  const here = { outcome: "home", environment: requester, projectId: null, reason: null } as const;
  if (request.mode === "check" && requester === "host") return here;
  for (const other of environments) {
    if (other === requester) continue;
    if (request.mode === "check" && other !== "host") continue;
    let list: FactoryList;
    try {
      list = ProjectFactoryListSchema.parse(await read(other));
    } catch {
      return {
        outcome: "unconfirmed",
        environment: null,
        projectId: null,
        reason: `The ${FACTORY_HOME_LABELS[other]} environment could not be read, so the Factory home for ${request.repository} is unconfirmed. Try again once it is running.`,
      };
    }
    const running = list.projects.find(
      (project) =>
        (project.state === "on" || project.state === "paused") &&
        sameRepository(project.repository, request.repository),
    );
    if (running)
      return {
        outcome: "elsewhere",
        environment: other,
        projectId: running.projectId,
        reason: `Factory for ${request.repository} runs in the ${FACTORY_HOME_LABELS[other]} environment (project ${running.projectId}), its Factory home. Turn it off there first; an installation runs one Factory per repository.`,
      };
  }
  return here;
}

/** Well under the daemon's wait, so a hung environment reads as unreadable, not a timeout. */
const FACTORY_LIST_READ_TIMEOUT_MS = 8_000;

/**
 * The coordinator's decision service. Requests run one at a time, so a claim always sees the
 * Factory a request before it recorded.
 */
export function createFactoryHomeAuthority(input: {
  environments: readonly ExecutionEnvironmentKind[];
  read: ReadFactoryList;
  readTimeoutMs?: number;
}) {
  const timeoutMs = input.readTimeoutMs ?? FACTORY_LIST_READ_TIMEOUT_MS;
  const read: ReadFactoryList = (kind) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${kind} did not answer`)), timeoutMs);
    });
    return Promise.race([input.read(kind), timeout]).finally(() => clearTimeout(timer));
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    decide(requester: ExecutionEnvironmentKind, request: FactoryHomeRequest) {
      const next = queue.then(() =>
        decideFactoryHome(requester, request, input.environments, read),
      );
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Reads a daemon's Factory list through the plugin RPC every Factory daemon serves. */
export async function readDaemonFactoryList(client: {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}): Promise<FactoryList> {
  try {
    return ProjectFactoryListSchema.parse(
      await client.invokePluginRpc("factory", factoryProjectList.name, {}),
    );
  } finally {
    await client.close();
  }
}

/** A daemon's view of its Factory home, or null outside an installation. */
export interface FactoryHomePort {
  environment: ExecutionEnvironmentKind;
  ask(request: FactoryHomeRequest): Promise<FactoryHomeAnswer>;
}

const FACTORY_HOME_TIMEOUT_MS = 20_000;

/**
 * The daemon side, over the launcher's installation credential. A coordinator from before the
 * home lock answers 404: the Host keeps the earlier local-only behavior and Dev reports the home
 * unconfirmed, so only the Host can turn Factory on until the coordinator is updated.
 */
export function createFactoryHomeClient(
  configFile: string | undefined,
  fetchHome: typeof fetch = fetch,
): FactoryHomePort | null {
  if (!configFile) return null;
  const unconfirmed = (reason: string): FactoryHomeAnswer => ({
    outcome: "unconfirmed",
    environment: null,
    projectId: null,
    reason,
  });
  let config: NonNullable<ReturnType<typeof readInstallationClientConfig>>;
  try {
    config = readInstallationClientConfig(configFile)!;
  } catch {
    // Without a readable credential no claim can be confirmed: refuse new Factories, keep
    // running ones. Treated as Dev, the environment that must ask.
    return {
      environment: "container",
      ask: async () =>
        unconfirmed(
          "The installation credential is unreadable, so the Factory home is unconfirmed.",
        ),
    };
  }
  const environment = config.kind === "host-agent" ? "host" : "container";
  return {
    environment,
    async ask(request) {
      let response: Response;
      try {
        response = await fetchHome(new URL(FACTORY_HOME_ROUTE, config.origin), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(FACTORY_HOME_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        return unconfirmed(
          `The installation coordinator did not answer, so the Factory home for ${request.repository} is unconfirmed. Try again shortly.`,
        );
      }
      // COMPAT(factoryHome): added 2026-11-08, remove after 2027-05-08. Older coordinators
      // have no home route; the Host is the default home.
      if (response.status === 404)
        return environment === "host"
          ? { outcome: "home", environment, projectId: null, reason: null }
          : unconfirmed(
              "The installation coordinator predates the Factory home lock, so Factory can only be turned on in the Host environment until it is updated.",
            );
      if (!response.ok)
        return unconfirmed(
          `The installation coordinator refused the Factory home request (${response.status}).`,
        );
      return FactoryHomeAnswerSchema.parse(await response.json());
    },
  };
}
