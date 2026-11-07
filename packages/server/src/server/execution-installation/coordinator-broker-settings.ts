import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorSettingField } from "@getpaseo/protocol/installation-upgrades";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import type { InstallationConfig } from "./config.js";
import {
  verifyBrokerBinding,
  type BrokerBindingPins,
  type BrokerSetting,
} from "./preview-broker-configuration-checks.js";
import { verifyExecutable } from "./preview-monitor-executor.js";

/**
 * Reviewed broker settings: `previewBrokerDeployment` and `previewBroker` name what the
 * coordinator executes, so a requester may move only their release code to another
 * installer-managed release. The coordinator derives every other value from what the
 * installation already records, and computes every digest from the bytes on disk.
 *
 * - Docker, socket and Dev container equal the installation's recorded connection.
 * - Recovery readers and Node bind the release and executable this coordinator runs, by the
 *   check the coordinator bootstrap review shares.
 * - Python, broker roots, launchd bindings, participant scope, consumer files and the
 *   evidence root stay where the installation already put them.
 * - Worker, modules, inspector and identity verifier are files inside the coordinator's and
 *   Host's release directories, never a worktree, temporary or project folder.
 * - Every file is canonical (no symlink), regular, owned by this account, not writable by
 *   group or others, outside writable Dev mounts, and hashes to the requested digest.
 *
 * The executors repeat their own protected-input checks before every broker effect.
 */
export const BROKER_SETTINGS: readonly BrokerSetting[] = [
  "previewBrokerDeployment",
  "previewBroker",
];

export function isBrokerSetting(key: string): key is BrokerSetting {
  return (BROKER_SETTINGS as readonly string[]).includes(key);
}

export interface BrokerSettingsReviewPorts {
  /** Writable Dev container mount roots, inspected through the pinned Docker endpoint. */
  writableMountRoots(connection: Omit<BrokerBindingPins, "recovery">): Promise<readonly string[]>;
  /** The Node executable this coordinator runs. */
  coordinatorNode(): string;
  /** The executors' own compatibility checks on the candidate configuration file. */
  executorInputs(input: {
    settings: readonly BrokerSetting[];
    config: InstallationConfig;
    configurationFile: { path: string; sha256: string };
    writableMountRoots(): Promise<readonly string[]>;
  }): Promise<void>;
}

export interface BrokerSettingsReview {
  keys: readonly BrokerSetting[];
  current: InstallationConfig;
  candidate: InstallationConfig;
  /** The candidate written privately on disk, for the deployment executor to reread. */
  candidateFile: { path: string; sha256: string };
}

interface Pin {
  path: string;
  sha256: string;
}

class BrokerSettingRefused extends Error {}

function refuse(reason: string): never {
  throw new BrokerSettingRefused(reason);
}

function contains(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function canonical(file: string): Promise<string | null> {
  try {
    return await realpath(file);
  } catch {
    return null;
  }
}

/** The release directories the installer manages, derived from the current configuration. */
export async function managedReleaseRoots(current: InstallationConfig): Promise<string[]> {
  const deployment = current.deployment;
  if (!deployment?.coordinator)
    refuse("Broker settings change only on installations made by the one-command installer.");
  const candidates = [
    // The installer's releases folder, which holds every coordinator and Host release.
    path.dirname(deployment.coordinator.releaseLink),
    deployment.coordinator.releaseLink,
    deployment.hostReleaseLink,
    current.sourceUpdates?.releaseRoot,
  ];
  // A layout that keeps a release link in the installation root must not admit that root,
  // which also holds state, worktrees and task folders.
  const excluded: string[] = [];
  for (const place of [
    deployment.installRoot,
    deployment.sourceDirectory,
    deployment.hostHome,
    deployment.containerHome,
    current.stateDir,
  ])
    if (place) excluded.push((await canonical(place)) ?? place);
  const roots = new Set<string>();
  for (const item of candidates) {
    const root = item ? await canonical(item) : null;
    if (!root) continue;
    if (excluded.some((place) => place === root || contains(root, place))) continue;
    roots.add(root);
  }
  if (roots.size === 0) refuse("This installation records no managed release directory.");
  return [...roots];
}

/** The Docker endpoint and Dev container the installation already uses. */
export function recordedConnection(
  current: InstallationConfig,
): Omit<BrokerBindingPins, "recovery"> {
  const recorded = [
    current.previewBrokerDeployment,
    current.previewBroker,
    current.previewMonitor,
    current.nativeHelper,
  ].find((item) => item !== undefined);
  const engine = current.container?.engineRestart ?? current.container?.engineRecovery;
  const docker = recorded?.docker ?? current.containerSourceUpdates?.docker ?? engine?.docker;
  const socket = recorded?.socket ?? engine?.socket;
  const containerId =
    recorded?.containerId ?? current.containerSourceUpdates?.containerId ?? engine?.containers.dev;
  const missing = [
    ["Docker executable", docker],
    ["Docker socket", socket],
    ["Dev container", containerId],
  ].find(([, value]) => !value)?.[0];
  if (missing)
    refuse(
      `The installation records no ${missing} for the broker to bind. The operator must set it in coordinator.json first.`,
    );
  return { docker: docker!, socket: socket!, containerId: containerId! };
}

async function digestFile(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function requireEqual(label: string, actual: unknown, expected: unknown): void {
  if (expected === undefined)
    refuse(
      `The installation records no ${label} for this broker. The operator must set it in coordinator.json first.`,
    );
  if (!isDeepStrictEqual(actual, expected))
    refuse(`${label} must stay ${JSON.stringify(expected)}, the value the installation records.`);
}

/** Leaves of a broker value: a file as its path and digest, anything else as its text. */
function leaves(value: unknown, prefix = "", into = new Map<string, unknown>()) {
  if (value === null || value === undefined) return into;
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaves(item, `${prefix}[${index}]`, into));
    return into;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length === 2 &&
      typeof record.path === "string" &&
      typeof record.sha256 === "string"
    ) {
      into.set(prefix, record);
      return into;
    }
    for (const [key, item] of Object.entries(record))
      leaves(item, prefix ? `${prefix}.${key}` : key, into);
    return into;
  }
  into.set(prefix, value);
  return into;
}

function display(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null && "sha256" in value) {
    const file = value as Pin;
    return `${file.path} · sha256 ${file.sha256.slice(0, 12)}`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Changed fields only, each a readable path and digest prefix rather than a JSON blob. */
export function brokerFieldChanges(before: unknown, after: unknown): CoordinatorSettingField[] {
  const previous = leaves(before);
  const next = leaves(after);
  const fields = [...new Set([...previous.keys(), ...next.keys()])];
  return fields
    .filter((field) => !isDeepStrictEqual(previous.get(field), next.get(field)))
    .map((field) => {
      const value = next.get(field);
      const change: CoordinatorSettingField = {
        field,
        before: display(previous.get(field)),
        after: display(value),
      };
      if (typeof value === "object" && value !== null) change.verified = true;
      return change;
    });
}

/** The files of one broker value, grouped by the rule that confines them. */
interface BrokerFiles {
  /** Interpreters: pinned paths, verified as protected executables. */
  executables: Pin[];
  /** Release code: inside an installer-managed release directory. */
  release: [string, Pin][];
  /** Files at recorded broker locations. */
  placed: Pin[];
}

/** Deployment placement stays as recorded; returns its files by rule. */
function deploymentFiles(current: InstallationConfig, candidate: InstallationConfig): BrokerFiles {
  const value = candidate.previewBrokerDeployment!;
  const recorded = current.previewBrokerDeployment;
  const label = (field: string) => `previewBrokerDeployment.${field}`;
  const plistPaths = (bindings: typeof value.bindings) =>
    bindings.map(({ plist, ...rest }) => Object.assign(rest, { plist: plist.path }));
  requireEqual(
    label("python"),
    value.python.path,
    (recorded ?? current.previewBroker)?.python.path,
  );
  requireEqual(label("roots"), value.roots, recorded?.roots);
  requireEqual(
    label("bindings"),
    plistPaths(value.bindings),
    recorded && plistPaths(recorded.bindings),
  );
  requireEqual(label("scope"), value.scope.path, recorded?.scope.path);
  requireEqual(
    label("evidenceRoot"),
    value.evidenceRoot,
    recorded?.evidenceRoot ?? current.previewBroker?.evidenceRoot,
  );
  return {
    executables: [value.python, value.recovery.node],
    release: [
      ["nativeInspector", value.nativeInspector],
      ["worker", value.worker],
      ...value.modules.map((pin, index): [string, Pin] => [`modules[${index}]`, pin]),
      ["recovery.journal", value.recovery.journal],
      ["recovery.queue", value.recovery.queue],
      ["recovery.configModule", value.recovery.configModule],
    ],
    placed: [value.scope, ...value.bindings.map((binding) => binding.plist)],
  };
}

/** Broker placement stays as recorded, or for a first broker follows the deployed roots. */
function brokerFiles(current: InstallationConfig, candidate: InstallationConfig): BrokerFiles {
  const value = candidate.previewBroker!;
  const recorded = current.previewBroker;
  const deployment = current.previewBrokerDeployment;
  const label = (field: string) => `previewBroker.${field}`;
  requireEqual(label("python"), value.python.path, (recorded ?? deployment)?.python.path);
  if (recorded) requireEqual(label("configPaths"), value.configPaths, recorded.configPaths);
  else
    requireEqual(
      label("configPaths folders"),
      value.configPaths.map((file) => path.dirname(file)),
      deployment?.roots,
    );
  requireEqual(
    label("evidenceRoot"),
    value.evidenceRoot,
    recorded?.evidenceRoot ?? deployment?.evidenceRoot,
  );
  // Installed consumers live in the pinned config folders; the executor checks their names.
  const folders = new Set(value.configPaths.map((file) => path.dirname(file)));
  for (const consumer of value.consumerFiles)
    if (!folders.has(path.dirname(consumer.path)))
      refuse(`${label("consumerFiles")}: ${consumer.path} is outside the broker's config folders.`);
  return {
    executables: [value.python, value.recovery.node],
    release: [
      ["worker", value.worker],
      ["identityModule", value.identityModule],
      ["recovery.journal", value.recovery.journal],
      ["recovery.queue", value.recovery.queue],
      ["recovery.configModule", value.recovery.configModule],
    ],
    placed: value.consumerFiles,
  };
}

/** Confines release code, then hashes every file from disk with its protection checks. */
async function verifyFiles(
  key: BrokerSetting,
  files: BrokerFiles,
  releaseRoots: readonly string[],
  mounts: readonly string[],
): Promise<void> {
  for (const [field, pin] of files.release) {
    if ((await canonical(pin.path)) !== pin.path)
      refuse(`${key}.${field}: ${pin.path} is a symbolic link or not a canonical path.`);
    if (!releaseRoots.some((root) => contains(root, pin.path)))
      refuse(
        `${key}.${field}: ${pin.path} must be a file inside an installer-managed release directory (${releaseRoots.join(", ")}).`,
      );
  }
  for (const pin of files.executables) {
    try {
      await verifyExecutable(pin, mounts);
    } catch (error) {
      refuse(`${key}: executable ${pin.path} was refused: ${describe(error)}`);
    }
  }
  for (const pin of [...files.release.map(([, item]) => item), ...files.placed]) {
    try {
      await readBootstrapPreparedFile(pin, mounts);
    } catch (error) {
      refuse(`${key}: ${pin.path} was refused: ${describe(error)}`);
    }
  }
}

/** Docker, socket and container are the installation's; recovery is this coordinator's. */
async function bindingPins(
  current: InstallationConfig,
  ports: BrokerSettingsReviewPorts,
): Promise<BrokerBindingPins> {
  const connection = recordedConnection(current);
  const releaseLink = current.deployment?.coordinator?.releaseLink;
  const directory = releaseLink ? await canonical(releaseLink) : null;
  if (!directory) refuse("The coordinator release directory cannot be resolved.");
  const node = await canonical(ports.coordinatorNode());
  if (!node) refuse("The coordinator's Node executable cannot be resolved.");
  return {
    ...connection,
    recovery: { directory, node: { path: node, sha256: await digestFile(node) } },
  };
}

/**
 * Reviews each broker key the candidate sets. Throws a message naming the refused field;
 * returns the per-field changes the owner reviews. Run at request and again at dispatch.
 */
export async function reviewBrokerSettings(
  review: BrokerSettingsReview,
  ports: BrokerSettingsReviewPorts,
): Promise<Record<string, CoordinatorSettingField[]>> {
  const { current, candidate } = review;
  const result: Record<string, CoordinatorSettingField[]> = {};
  for (const key of review.keys) result[key] = brokerFieldChanges(current[key], candidate[key]);
  const attached = review.keys.filter((key) => candidate[key] !== undefined);
  if (attached.length === 0) return result;

  const { recovery, ...connection } = await bindingPins(current, ports);
  const releaseRoots = await managedReleaseRoots(current);
  const mounts = await ports.writableMountRoots(connection);
  for (const key of attached) {
    try {
      verifyBrokerBinding(key, candidate[key], { ...connection, recovery });
    } catch (error) {
      refuse(
        `${key}: ${describe(error)}. Docker, socket and Dev container must equal the installation's (${connection.docker}, ${connection.socket}); recovery readers and Node must be this coordinator's release and executable.`,
      );
    }
    const files =
      key === "previewBrokerDeployment"
        ? deploymentFiles(current, candidate)
        : brokerFiles(current, candidate);
    await verifyFiles(key, files, releaseRoots, mounts);
  }
  try {
    await ports.executorInputs({
      settings: attached,
      config: candidate,
      configurationFile: review.candidateFile,
      writableMountRoots: () => ports.writableMountRoots(connection),
    });
  } catch (error) {
    refuse(describe(error));
  }
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
