import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  CustomDomainChangeSchema,
  type CustomDomainStatus,
} from "@getpaseo/protocol/custom-domain";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { writePrivateFileAtomic } from "../private-files.js";
import { readInstallationConfig, remoteAccess, type InstallationConfig } from "./config.js";
import {
  launchHandoff,
  readHandoffOutcome,
  type CoordinatorConfigPlan,
} from "./coordinator-handoff.js";
import { managedServices } from "./service-control.js";

/** One readiness window; a failed change waits twice, then restores. */
const COORDINATOR_READY_TIMEOUT_MS = 120_000;
const CHANGE_DEADLINE_MS = COORDINATOR_READY_TIMEOUT_MS * 2 + 60_000;

export class CustomDomainUnavailable extends Error {}
export class CustomDomainConflict extends Error {}

interface ChangeRecord {
  id: string;
  origin: string | null;
  startedAt: string;
}

export interface CustomDomainPorts {
  connect(kind: ExecutionEnvironmentKind): Promise<DaemonClient>;
  launch: typeof launchHandoff;
  now(): Date;
}

/**
 * Owner-set custom domain for installer-made installations: the coordinator's
 * `recoveryOrigin`. A change admits the origin to the Host and Dev daemons (add-only,
 * live), keeps a private backup of the configuration file, writes the new one in place
 * and hands a coordinator-only restart to the detached handoff helper, which restores the
 * backup if this installation's coordinator does not answer again. The owner's own
 * request in Installation controls is the review; agents cannot reach these routes.
 */
export function createCustomDomain(input: {
  config: InstallationConfig;
  configFile: string | undefined;
  logger: Logger;
  ports: CustomDomainPorts;
  /** Another coordinator restart, such as an upgrade or settings change, in progress. */
  restartBlocker?: () => string | null;
}) {
  const { config, configFile, logger, ports } = input;
  const directory = path.join(config.stateDir, "custom-domain");
  const lastFile = path.join(directory, "last.json");
  const helper = async () =>
    path.join(path.dirname(await realpath(process.argv[1]!)), "coordinator-handoff-main.js");

  function blocker(): string | null {
    if (!configFile) return "This coordinator was started without its configuration file.";
    // Source-update installations change configuration through reviewed coordinator updates.
    if (config.sourceUpdates || !config.deployment?.coordinator?.releaseLink)
      return "Only installations made by the one-command installer change their domain here.";
    const services = managedServices(config);
    if (typeof services === "string") return services;
    if (remoteAccess(config) === "none") return "Local-only installations have no custom domain.";
    return input.restartBlocker?.() ?? null;
  }

  function revision(last: ChangeRecord | null): string {
    // The running coordinator's value plus the last change, so a stale page cannot race.
    return createHash("sha256")
      .update(JSON.stringify([config.recoveryOrigin ?? null, last?.id ?? null]))
      .digest("hex")
      .slice(0, 32);
  }

  async function readLast(): Promise<ChangeRecord | null> {
    try {
      return JSON.parse(await readFile(lastFile, "utf8")) as ChangeRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function status(): Promise<CustomDomainStatus> {
    const reason = blocker();
    const last = await readLast();
    let lastChange: CustomDomainStatus["lastChange"] = null;
    if (last) {
      const outcome = readHandoffOutcome(path.join(directory, last.id, "outcome.json"));
      // A helper that never reported back cannot hold later changes forever.
      const abandoned =
        !outcome && ports.now().getTime() - Date.parse(last.startedAt) > CHANGE_DEADLINE_MS;
      lastChange = {
        ...last,
        status: outcome?.status ?? (abandoned ? "failed" : "running"),
        detail:
          outcome?.detail ??
          (abandoned
            ? "The coordinator restart never reported back. Check that the domain is listed above before retrying."
            : "Restarting the coordinator."),
        finishedAt: outcome?.finishedAt ?? null,
      };
    }
    return {
      available: reason === null,
      reason,
      origin: config.recoveryOrigin ?? null,
      revision: revision(last),
      lastChange,
    };
  }

  /** Adds `origin` to one daemon's allowed browser origins; a present origin is a no-op. */
  async function admit(kind: ExecutionEnvironmentKind, origin: string): Promise<void> {
    const serverId = config.public.environments.find((item) => item.kind === kind)?.serverId;
    if (!serverId) throw new Error(`The ${kind} environment is missing`);
    const client = await ports.connect(kind);
    try {
      const observed = await client.inspectOriginAdmission({
        expectedServerId: serverId,
      });
      if (observed.state !== "ready" || observed.activeOrigins === null)
        throw new CustomDomainUnavailable(
          `The ${kind === "host" ? "Host" : "Dev"} daemon cannot add origins: ${
            observed.reason ?? "unavailable"
          }`,
        );
      if (observed.persistedOrigins.includes(origin) && observed.activeOrigins.includes(origin))
        return;
      const result = await client.admitOrigin({
        origin,
        expectedServerId: serverId,
        expectedPersistedOrigins: observed.persistedOrigins,
        expectedActiveOrigins: observed.activeOrigins,
      });
      if (result.state !== "applied")
        throw new Error(
          `The ${kind === "host" ? "Host" : "Dev"} daemon did not add the origin: ${result.reason}`,
        );
    } finally {
      await client.close();
    }
  }

  let changing = false;

  /**
   * True while a change is being prepared or its coordinator restart has not reported, so
   * other coordinator restarts wait. Synchronous for the shared restart check.
   */
  function running(): boolean {
    if (changing) return true;
    try {
      const last = JSON.parse(readFileSync(lastFile, "utf8")) as ChangeRecord;
      if (readHandoffOutcome(path.join(directory, last.id, "outcome.json"))) return false;
      return ports.now().getTime() - Date.parse(last.startedAt) <= CHANGE_DEADLINE_MS;
    } catch {
      // No change recorded, or an unreadable record that status() reports instead.
      return false;
    }
  }

  /** One change at a time: the checks below span awaits before the change is recorded. */
  async function change(body: unknown): Promise<CustomDomainStatus> {
    if (changing) throw new CustomDomainConflict("A custom domain change is still running.");
    changing = true;
    try {
      return await applyChange(body);
    } finally {
      changing = false;
    }
  }

  async function applyChange(body: unknown): Promise<CustomDomainStatus> {
    const request = CustomDomainChangeSchema.parse(body);
    const reason = blocker();
    if (reason) throw new CustomDomainUnavailable(reason);
    const current = await status();
    if (request.expectedRevision !== current.revision)
      throw new CustomDomainConflict("The custom domain changed. Reload and try again.");
    if (current.lastChange?.status === "running")
      throw new CustomDomainConflict("A custom domain change is still running.");
    if (request.origin === (config.recoveryOrigin ?? null)) return current;
    if (request.origin === config.public.origin)
      throw new CustomDomainUnavailable("The custom domain must differ from the main address.");
    const file = configFile!;
    const services = managedServices(config);
    if (typeof services === "string") throw new CustomDomainUnavailable(services);

    // Daemons first: the coordinator would otherwise serve an interface whose live
    // connections the daemons refuse. Admission is add-only, so a removal leaves them.
    if (request.origin) {
      await admit("host", request.origin);
      if (config.container) await admit("container", request.origin);
    }

    const raw = await readFile(file, "utf8");
    const next = JSON.parse(raw) as Record<string, unknown>;
    if (request.origin) next.recoveryOrigin = request.origin;
    else delete next.recoveryOrigin;
    const id = randomUUID();
    const work = path.join(directory, id);
    await mkdir(work, { recursive: true, mode: 0o700 });
    const backupFile = path.join(work, "coordinator.json.before");
    const candidate = path.join(work, "coordinator.json.candidate");
    await writePrivateFileAtomic(backupFile, raw);
    const candidateText = `${JSON.stringify(next, null, 2)}\n`;
    await writePrivateFileAtomic(candidate, candidateText);
    // The full startup validation the next coordinator runs, before anything is replaced.
    const validated = readInstallationConfig(candidate);
    if (validated.public.installationId !== config.public.installationId)
      throw new Error("The candidate configuration names a different installation");
    const helperFile = await helper();

    await writePrivateFileAtomic(
      lastFile,
      JSON.stringify({
        id,
        origin: request.origin,
        startedAt: ports.now().toISOString(),
      } satisfies ChangeRecord),
    );
    await writePrivateFileAtomic(file, candidateText);
    const plan: CoordinatorConfigPlan = {
      kind: "coordinator-config",
      id,
      configFile: file,
      backupFile,
      services,
      health: {
        url: `http://127.0.0.1:${config.listenPort}/api/installation/health`,
        installationId: config.public.installationId,
        previousPid: process.pid,
      },
      outcomeFile: path.join(work, "outcome.json"),
      timeoutMs: COORDINATOR_READY_TIMEOUT_MS,
    };
    try {
      ports.launch({
        node: process.execPath,
        helper: helperFile,
        planFile: path.join(work, "plan.json"),
        logFile: path.join(work, "handoff.log"),
        plan,
      });
    } catch (error) {
      // Nothing restarted: put the running configuration back on disk.
      await writePrivateFileAtomic(file, raw);
      await writePrivateFileAtomic(
        plan.outcomeFile,
        JSON.stringify({
          id,
          status: "failed",
          detail: `The coordinator restart could not start; nothing changed (${
            error instanceof Error ? error.message : String(error)
          }).`,
          finishedAt: ports.now().toISOString(),
        }),
      );
      throw error;
    }
    logger.info({ changeId: id, origin: request.origin }, "Custom domain change started");
    return status();
  }

  return { status, change, running };
}
