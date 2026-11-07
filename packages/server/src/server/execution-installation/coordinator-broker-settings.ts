import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorSettingField } from "@getpaseo/protocol/installation-upgrades";
import { BrokerDeploymentScopeSchema } from "@getpaseo/protocol/preview-broker-deployment";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import type { InstallationConfig } from "./config.js";
import {
  verifyBrokerBinding,
  type BrokerBindingPins,
  type BrokerSetting,
} from "./preview-broker-configuration-checks.js";
import { verifyExecutable } from "./preview-monitor-executor.js";

/**
 * Reviewed broker settings: `previewBrokerDeployment` and `previewBroker` name what the
 * coordinator executes. The requester picks one anchored release; the coordinator derives
 * everything else and computes every digest from the bytes on disk.
 *
 * - Release code (worker, modules, native inspector, identity verifier) lives at fixed paths in
 *   ONE release: the installed Host release or the running coordinator release. No other
 *   retained release, build cache or source checkout qualifies, so a downgrade, a module mixed
 *   in from another release, or an arbitrary script is refused.
 * - Recovery readers and Node bind the release and executable this coordinator runs, by the
 *   check the coordinator bootstrap review shares.
 * - Docker, socket and Dev container come from one recorded configuration section.
 * - Python, broker roots, launchd bindings, scope path, consumer files and the evidence root
 *   stay where the installation already put them.
 * - The coordinator writes the deployment participant scope itself, bounded to 24 hours with no
 *   manual participants, instead of accepting a requester's file. A request probes with a
 *   private review copy; only dispatch, after approval, writes the recorded scope path.
 *
 * Who this stops: Host agents run as the owner's account, so the ownership, mode and link
 * checks below stop Dev-side tampering (writable Dev mounts) and mistakes, not a Host agent.
 * A Host agent can also change a release's files and its commit label: the commit comes from a
 * receipt the same account can write, or the folder name, and no artifact digest binds it to
 * the contents. Owner approval of "release <commit>" therefore cannot detect Host-agent
 * tampering; it confirms which release and recorded values a well-behaved requester chose.
 * Dispatch repeats every check, and the executors repeat theirs before each broker effect.
 */
export const BROKER_SETTINGS: readonly BrokerSetting[] = [
  "previewBrokerDeployment",
  "previewBroker",
];

export function isBrokerSetting(key: string): key is BrokerSetting {
  return (BROKER_SETTINGS as readonly string[]).includes(key);
}

/** The minted participant scope never outlives this bound. */
export const SCOPE_LIFETIME_MS = 24 * 60 * 60_000;
/** The deployment executor needs this much scope left to run. */
const SCOPE_MARGIN_MS = 180_000;

/** Release code paths, relative to the anchored release. */
const DEPLOYMENT_CODE = {
  worker: "docker/tailscale/broker_deployment_worker.py",
  nativeInspector: "scripts/inspect-coordinator-process.py",
  // The deployment executor loads exactly these modules, in this order, by basename.
  modules: [
    "channel_identity",
    "broker_rebind",
    "broker_deployment",
    "broker_deployment_kernel",
    "broker_deployment_observation",
  ].map((name) => `docker/tailscale/${name}.py`),
};
const BROKER_CODE = {
  worker: "docker/tailscale/broker_rebind.py",
  identityModule: "docker/tailscale/channel_identity.py",
};

export interface BrokerSettingsReviewPorts {
  /** Writable Dev container mount roots, inspected through the pinned Docker endpoint. */
  writableMountRoots(connection: Omit<BrokerBindingPins, "recovery">): Promise<readonly string[]>;
  /** The Node executable this coordinator runs. */
  coordinatorNode(): string;
  /** The executors' own compatibility checks on the candidate configuration. */
  executorInputs(input: {
    settings: readonly BrokerSetting[];
    config: InstallationConfig;
    writableMountRoots(): Promise<readonly string[]>;
  }): Promise<void>;
  now(): Date;
  randomUUID(): string;
  /** This boot's session UUID, which the participant scope binds. */
  bootUUID(): Promise<string>;
  /** Replaces the file at `file` privately and atomically with `text`. */
  writeScope(file: string, text: string): Promise<void>;
  /** A fresh private path for the request-time review copy of the scope. */
  reviewScopeFile(): string;
  removeFile(file: string): Promise<void>;
}

export interface BrokerSettingsReview {
  keys: readonly BrokerSetting[];
  current: InstallationConfig;
  candidate: InstallationConfig;
  /**
   * A request mints the participant scope into a private review copy for the executor probe;
   * dispatch mints it at the recorded scope path.
   */
  phase: "request" | "dispatch";
}

export interface BrokerSettingsReviewResult {
  /** Changed fields per key, for the owner. */
  fields: Record<string, CoordinatorSettingField[]>;
  /** The values to store, with coordinator-filled entries such as the minted scope digest. */
  values: Partial<Record<BrokerSetting, unknown>>;
}

interface Pin {
  path: string;
  sha256: string;
}

/** The request does not match what the installation allows; fails the change. */
export class BrokerSettingRefused extends Error {}

/** A check could not run, such as a Docker inspection timeout; dispatch retries. */
export class BrokerReviewUnavailable extends Error {}

function refuse(reason: string): never {
  throw new BrokerSettingRefused(reason);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSIENT_CODES = new Set(["EIO", "EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT"]);

/** Wraps a failing check: transient system errors stay retryable, anything else refuses. */
async function check<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrokerSettingRefused || error instanceof BrokerReviewUnavailable)
      throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_CODES.has(code))
      throw new BrokerReviewUnavailable(`${label}: ${describe(error)}`);
    refuse(`${label}: ${describe(error)}`);
  }
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

interface AnchoredRelease {
  directory: string;
  kind: "Host" | "coordinator";
}

/** The installed Host release and the running coordinator release, canonical. */
export async function anchoredReleases(current: InstallationConfig): Promise<AnchoredRelease[]> {
  const deployment = current.deployment;
  if (!deployment?.coordinator)
    refuse("Broker settings change only on installations made by the one-command installer.");
  // A release link that resolves to the installation root, its state, source or homes would
  // admit worktrees and task folders; such a link is not an anchor.
  const excluded: string[] = [];
  for (const place of [
    deployment.installRoot,
    deployment.sourceDirectory,
    deployment.hostHome,
    deployment.containerHome,
    current.stateDir,
  ])
    if (place) excluded.push((await canonical(place)) ?? place);
  const anchors: AnchoredRelease[] = [];
  for (const [link, kind] of [
    [deployment.hostReleaseLink ?? current.sourceUpdates?.currentReleaseLink, "Host"],
    [deployment.coordinator.releaseLink, "coordinator"],
  ] as const) {
    const directory = link ? await canonical(link) : null;
    if (!directory) continue;
    if (excluded.some((place) => place === directory || contains(directory, place))) continue;
    if (!anchors.some((item) => item.directory === directory)) anchors.push({ directory, kind });
  }
  if (anchors.length === 0) refuse("This installation records no installed release.");
  return anchors;
}

/** The release's source commit, from its installation receipt or its commit-named folder. */
async function releaseCommit(directory: string): Promise<string> {
  const commit = /^[a-f0-9]{40}$/;
  try {
    const receipt = JSON.parse(
      (await readProtectedDocument(path.join(directory, ".installation-source.json"))).toString(
        "utf8",
      ),
    ) as { sourceCommit?: unknown };
    if (typeof receipt.sourceCommit === "string" && commit.test(receipt.sourceCommit))
      return receipt.sourceCommit;
  } catch {
    // Fall back to the folder name below.
  }
  if (commit.test(path.basename(directory))) return path.basename(directory);
  refuse(`Release ${directory} records no source commit.`);
}

/**
 * Docker endpoint and Dev container from ONE recorded section, never mixed across sections:
 * the broker's own, then the preview monitor's, native helper's or Dev engine restart's.
 */
export function recordedConnection(
  current: InstallationConfig,
): Omit<BrokerBindingPins, "recovery"> {
  const section = [
    current.previewBrokerDeployment,
    current.previewBroker,
    current.previewMonitor,
    current.nativeHelper,
  ].find((item) => item !== undefined);
  if (section)
    return { docker: section.docker, socket: section.socket, containerId: section.containerId };
  const engine = current.container?.engineRestart ?? current.container?.engineRecovery;
  if (engine)
    return { docker: engine.docker, socket: engine.socket, containerId: engine.containers.dev };
  refuse(
    "The installation records no Docker executable, socket and Dev container together for the broker to bind. The operator must set them in coordinator.json first.",
  );
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
  /** Code as [field, requested pin, derived path]: the anchored release or the readers. */
  code: [string, Pin, string][];
  /** Files at recorded broker locations. */
  placed: Pin[];
}

/** The anchored release the worker names; every other code path must follow it. */
function selectRelease(
  key: BrokerSetting,
  worker: string,
  relative: string,
  anchors: readonly AnchoredRelease[],
): AnchoredRelease {
  const release = anchors.find((item) => path.join(item.directory, relative) === worker);
  if (!release)
    refuse(
      `${key}.worker must be ${relative} in the installed Host or running coordinator release (${anchors.map((item) => item.directory).join(", ")}).`,
    );
  return release;
}

/** Deployment placement stays as recorded; code follows the selected release. */
function deploymentFiles(
  current: InstallationConfig,
  candidate: InstallationConfig,
  release: string,
): BrokerFiles {
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
  if (value.modules.length !== DEPLOYMENT_CODE.modules.length)
    refuse(`${label("modules")} must be the release's ${DEPLOYMENT_CODE.modules.length} modules.`);
  const at = (relative: string) => path.join(release, relative);
  return {
    executables: [value.python, value.recovery.node],
    code: [
      ["worker", value.worker, at(DEPLOYMENT_CODE.worker)],
      ["nativeInspector", value.nativeInspector, at(DEPLOYMENT_CODE.nativeInspector)],
      ...DEPLOYMENT_CODE.modules.map((relative, index): [string, Pin, string] => [
        `modules[${index}]`,
        value.modules[index]!,
        at(relative),
      ]),
    ],
    placed: value.bindings.map((binding) => binding.plist),
  };
}

/** Broker placement stays as recorded, or for a first broker follows the deployed roots. */
function brokerFiles(
  current: InstallationConfig,
  candidate: InstallationConfig,
  release: string,
): BrokerFiles {
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
    code: [
      ["worker", value.worker, path.join(release, BROKER_CODE.worker)],
      ["identityModule", value.identityModule, path.join(release, BROKER_CODE.identityModule)],
    ],
    placed: value.consumerFiles,
  };
}

/** Recovery readers; the shared binding check already placed them in the coordinator release. */
function recoveryFiles(recovery: Record<"journal" | "queue" | "configModule", Pin>) {
  return (["journal", "queue", "configModule"] as const).map((name): [string, Pin, string] => [
    `recovery.${name}`,
    recovery[name],
    recovery[name].path,
  ]);
}

/** Code at its derived path, then every file hashed from disk with its protection checks. */
async function verifyFiles(
  key: BrokerSetting,
  files: BrokerFiles,
  mounts: readonly string[],
): Promise<void> {
  for (const [field, pin, expected] of files.code) {
    if (pin.path !== expected) refuse(`${key}.${field} must be ${expected}.`);
    if ((await canonical(pin.path)) !== pin.path)
      refuse(`${key}.${field}: ${pin.path} is a symbolic link or not a canonical path.`);
  }
  for (const pin of files.executables)
    await check(`${key}: executable ${pin.path} was refused`, () => verifyExecutable(pin, mounts));
  for (const pin of [...files.code.map(([, item]) => item), ...files.placed])
    await check(`${key}: ${pin.path} was refused`, () => readBootstrapPreparedFile(pin, mounts));
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

type DeploymentValue = NonNullable<InstallationConfig["previewBrokerDeployment"]>;

/** Writes a fresh participant scope at `file` and returns its file pin. */
async function mintScope(
  value: DeploymentValue,
  file: string,
  installationId: string,
  ports: BrokerSettingsReviewPorts,
): Promise<Pin> {
  const bootUUID = await ports.bootUUID().catch((error: unknown) => {
    throw new BrokerReviewUnavailable(`The boot identity could not be read: ${describe(error)}`);
  });
  const scope = BrokerDeploymentScopeSchema.parse({
    version: 1,
    installationId,
    requestId: ports.randomUUID(),
    bootUUID,
    validUntil: new Date(ports.now().getTime() + SCOPE_LIFETIME_MS).toISOString(),
    declaration:
      "Only the declared managed routes and manual participants are known; no new manual broker calls until release",
    bindings: value.bindings,
    manualParticipants: [],
  });
  const text = `${JSON.stringify(scope, null, 2)}\n`;
  await check("The participant scope could not be written", () => ports.writeScope(file, text));
  return { path: file, sha256: createHash("sha256").update(text).digest("hex") };
}

/** The scope on disk must be coordinator-shaped: bounded, bound and without extras. */
async function verifyScope(
  value: DeploymentValue,
  installationId: string,
  mounts: readonly string[],
  now: Date,
) {
  const bytes = await check(`previewBrokerDeployment: ${value.scope.path} was refused`, () =>
    readBootstrapPreparedFile(value.scope, mounts),
  );
  let parsed: ReturnType<typeof BrokerDeploymentScopeSchema.safeParse>;
  try {
    parsed = BrokerDeploymentScopeSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch {
    refuse("The participant scope is not valid JSON.");
  }
  if (!parsed.success) refuse("The participant scope is not a valid scope.");
  const scope = parsed.data;
  const left = Date.parse(scope.validUntil) - now.getTime();
  if (scope.installationId !== installationId || !isDeepStrictEqual(scope.bindings, value.bindings))
    refuse("The participant scope names another installation or other broker routes.");
  if (scope.manualParticipants.length > 0)
    refuse("The participant scope declares manual participants the installation does not record.");
  if (left <= SCOPE_MARGIN_MS || left > SCOPE_LIFETIME_MS)
    refuse(
      `The participant scope must be valid for at most 24 hours; it ends ${scope.validUntil}.`,
    );
  return scope;
}

/** One broker key: pins, anchored code, files on disk, and the minted or verified scope. */
async function reviewKey(
  key: BrokerSetting,
  candidate: InstallationConfig,
  context: {
    current: InstallationConfig;
    pins: BrokerBindingPins;
    anchors: readonly AnchoredRelease[];
    mounts: readonly string[];
    phase: BrokerSettingsReview["phase"];
    ports: BrokerSettingsReviewPorts;
  },
): Promise<{ shown: CoordinatorSettingField[]; probeScope?: Pin }> {
  const { current, pins, ports } = context;
  try {
    verifyBrokerBinding(key, candidate[key], pins);
  } catch (error) {
    refuse(
      `${key}: ${describe(error)}. Docker, socket and Dev container must equal the installation's (${pins.docker}, ${pins.socket}); recovery readers and Node must be this coordinator's release and executable.`,
    );
  }
  const value = candidate[key] as { worker: Pin; recovery: Parameters<typeof recoveryFiles>[0] };
  const relative = key === "previewBrokerDeployment" ? DEPLOYMENT_CODE.worker : BROKER_CODE.worker;
  const release = selectRelease(key, value.worker.path, relative, context.anchors);
  const files =
    key === "previewBrokerDeployment"
      ? deploymentFiles(current, candidate, release.directory)
      : brokerFiles(current, candidate, release.directory);
  files.code.push(...recoveryFiles(value.recovery));
  await verifyFiles(key, files, context.mounts);
  const commit = await releaseCommit(release.directory);
  const shown: CoordinatorSettingField[] = [
    {
      field: "release",
      before: null,
      after: `release ${commit.slice(0, 12)} (${release.kind} release, ${release.directory})`,
      verified: true,
    },
  ];
  if (key !== "previewBrokerDeployment") return { shown };
  const deployment = candidate.previewBrokerDeployment!;
  const installationId = current.public.installationId;
  if (context.phase === "request") {
    // Nothing at the recorded path changes before approval: the stored value keeps the
    // recorded scope, and the executor probe reads a private copy minted the same way.
    candidate.previewBrokerDeployment = {
      ...deployment,
      scope: current.previewBrokerDeployment!.scope,
    };
    const probe = {
      ...deployment,
      scope: await mintScope(deployment, ports.reviewScopeFile(), installationId, ports),
    };
    try {
      await verifyScope(probe, installationId, context.mounts, ports.now());
    } catch (error) {
      await ports.removeFile(probe.scope.path).catch(() => {});
      throw error;
    }
    shown.push({
      field: "scope",
      before: null,
      after: `${deployment.scope.path}, written when applied: recorded routes, no manual participants, valid 24 hours on this boot`,
    });
    return { shown, probeScope: probe.scope };
  }
  const minted = {
    ...deployment,
    scope: await mintScope(deployment, deployment.scope.path, installationId, ports),
  };
  candidate.previewBrokerDeployment = minted;
  await verifyScope(minted, installationId, context.mounts, ports.now());
  return { shown };
}

/**
 * Reviews each broker key the candidate sets. Throws BrokerSettingRefused naming the refused
 * field, or BrokerReviewUnavailable when a check could not run. Run at request and dispatch.
 */
export async function reviewBrokerSettings(
  review: BrokerSettingsReview,
  ports: BrokerSettingsReviewPorts,
): Promise<BrokerSettingsReviewResult> {
  const { current } = review;
  const candidate: InstallationConfig = { ...review.candidate };
  const values: Partial<Record<BrokerSetting, unknown>> = {};
  const shown: Record<string, CoordinatorSettingField[]> = {};
  const attached = review.keys.filter((key) => candidate[key] !== undefined);
  if (attached.length > 0) {
    const pins = await bindingPins(current, ports);
    const anchors = await anchoredReleases(current);
    const { recovery: _recovery, ...connection } = pins;
    const mounts = await ports.writableMountRoots(connection).catch((error: unknown) => {
      throw new BrokerReviewUnavailable(`Docker mount inspection failed: ${describe(error)}`);
    });
    const context = { current, pins, anchors, mounts, phase: review.phase, ports };
    let probeScope: Pin | undefined;
    try {
      for (const key of attached) {
        const result = await reviewKey(key, candidate, context);
        shown[key] = result.shown;
        probeScope ??= result.probeScope;
        values[key] = candidate[key];
      }
      const probe: InstallationConfig =
        probeScope && candidate.previewBrokerDeployment
          ? {
              ...candidate,
              previewBrokerDeployment: { ...candidate.previewBrokerDeployment, scope: probeScope },
            }
          : candidate;
      await check("The broker executors refused the configuration", () =>
        ports.executorInputs({
          settings: attached,
          config: probe,
          writableMountRoots: () => ports.writableMountRoots(connection),
        }),
      );
    } finally {
      if (probeScope) await ports.removeFile(probeScope.path).catch(() => {});
    }
  }
  const fields: Record<string, CoordinatorSettingField[]> = {};
  for (const key of review.keys)
    fields[key] = [...(shown[key] ?? []), ...brokerFieldChanges(current[key], candidate[key])];
  return { fields, values };
}
