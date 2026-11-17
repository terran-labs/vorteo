import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { CapturedQuotaExecutionClient } from "../agent/agent-sdk-types.js";
import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import type { QuotaScheduleExecution } from "./quota-preflight.js";
import { isAbsolute, join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface GovernedScheduleRuntimeContext {
  hostId: string;
  paseoHome: string;
  /** Actual native accounting directory, distinct from the daemon's identity and agent home. */
  governorDirectory?: string;
  store: QuotaGovernorStore;
  readObservation(providerId: string): Promise<QuotaObservation>;
  captureClient(providerId: string): CapturedQuotaExecutionClient;
}

/** Trusted host integration only. No runtime factory or callback enters worker RPC configuration. */
export interface GovernedScheduleRuntime extends QuotaScheduleExecution {
  /** Bind authentication and persist estimated accounting before preflight admission. */
  readObservation(providerId: string): Promise<QuotaObservation>;
  /** Revoke synchronously, then settle captured work or reject with retained recovery custody. */
  stop(): Promise<void>;
}

export interface CreateGovernedScheduleRuntime {
  (context: GovernedScheduleRuntimeContext): Promise<GovernedScheduleRuntime>;
  /** Selected by the trusted startup module, never by worker configuration or RPC. */
  readonly governorDirectory?: string;
}

function isFactory(value: unknown): value is CreateGovernedScheduleRuntime {
  return typeof value === "function";
}

function isRuntime(value: unknown): value is GovernedScheduleRuntime {
  if (typeof value !== "object" || value === null) return false;
  return ["reconcile", "reconcilePreparation", "prepare", "readObservation", "stop"].every(
    (name) => typeof Reflect.get(value, name) === "function",
  );
}

/** Startup-only host code, loaded by the supervised daemon worker, never by a schedule. */
export async function loadGovernedScheduleRuntimeFactory(
  modulePath: string | undefined,
): Promise<CreateGovernedScheduleRuntime | undefined> {
  if (modulePath === undefined) return undefined;
  if (!isAbsolute(modulePath) || !modulePath.endsWith(".mjs")) {
    throw new Error("Governed runtime requires an absolute installed .mjs module path.");
  }
  const owner = process.getuid?.();
  const info = await lstat(modulePath);
  if (
    owner === undefined ||
    !info.isFile() ||
    info.uid !== owner ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(modulePath)) !== modulePath
  ) {
    throw new Error("Governed runtime requires an owner-controlled physical module.");
  }
  // This is trusted daemon code, not a sandbox or a package-signature check.
  // Its entire installation, dependencies and parents must be outside worker writes.
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  const factory =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "createGovernedScheduleRuntime")
      : undefined;
  if (!isFactory(factory)) throw new Error("Governed runtime factory export is missing.");
  const directory = await readRetainedGovernorDirectory(loaded, owner);
  const create: CreateGovernedScheduleRuntime = async (context) => {
    const runtime: unknown = await factory(context);
    if (!isRuntime(runtime)) throw new Error("Governed runtime lifecycle contract is incomplete.");
    return runtime;
  };
  if (directory !== undefined)
    Object.defineProperty(create, "governorDirectory", { value: directory });
  return create;
}

async function readRetainedGovernorDirectory(
  loaded: unknown,
  owner: number,
): Promise<string | undefined> {
  const directory: unknown =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "quotaGovernorDirectory")
      : undefined;
  if (directory !== undefined) {
    if (typeof directory !== "string" || !isAbsolute(directory))
      throw new Error("Retained governor directory must be an absolute path");
    const state = await lstat(directory);
    if (
      !state.isDirectory() ||
      state.uid !== owner ||
      (state.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Retained governor directory must be an owner-private physical directory");
  }
  return directory;
}

export function resolveGovernorDirectory(
  factory: CreateGovernedScheduleRuntime | undefined,
  paseoHome: string,
): string {
  return factory?.governorDirectory ?? join(paseoHome, "quota-governor");
}
