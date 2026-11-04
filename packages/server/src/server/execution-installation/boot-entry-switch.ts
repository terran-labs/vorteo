import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { BootEntrySwitchConfiguration } from "@getpaseo/protocol/execution-installation";
import { compareFactoryFacts } from "./factory-gate.js";
import {
  assertFactoryVerifyScript,
  defaultRun,
  runFactoryVerify,
  type EngineCommand,
  type FactoryFacts,
} from "./factory-verify.js";

const DEFAULT_DEADLINE_SECONDS = 300;
const COMMAND_TIMEOUT_MS = 30_000;

export interface BootEntrySwitchDependencies {
  run?: EngineCommand;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** What preflight observed; readiness and Factory verification compare against it. */
export interface BootEntrySwitchPreflight {
  containerStartedAt: string;
  supervisorPid: number;
  factory: FactoryFacts;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The pointer file names the entry module followed by a newline, as the image writes it. */
export function bootEntryPointerBytes(entryPath: string): string {
  return `${entryPath}\n`;
}

/** The target entry copied from the Host must be an owner-controlled physical file. */
function readTargetSource(plan: BootEntrySwitchConfiguration): Buffer | null {
  const source = plan.target.source;
  if (!source) return null;
  const file = lstatSync(source);
  if (
    !file.isFile() ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 ||
    realpathSync(source) !== source
  )
    throw new Error("Boot entry source must be an owner-controlled physical file");
  const bytes = readFileSync(source);
  if (sha256(bytes) !== plan.target.sha256) throw new Error("Boot entry source changed");
  return bytes;
}

/**
 * The digest owners approve: the exact plan, with its Host-side inputs checked. A missing
 * Docker binary, changed source or changed Factory script withholds the capability.
 */
export function bootEntrySwitchPlanDigest(
  plan: BootEntrySwitchConfiguration | undefined,
): string | undefined {
  if (!plan) return undefined;
  try {
    accessSync(plan.docker, constants.X_OK);
    readTargetSource(plan);
    assertFactoryVerifyScript(plan.factoryVerify);
    if (plan.current.entry.path === plan.target.path) return undefined;
    return sha256(canonicalJson({ kind: "dev-boot-entry-switch-v1", plan }));
  } catch {
    return undefined;
  }
}

/** The Factory check script digest each coordinator gate pins; absent gates are omitted. */
export interface FactoryCheckPins {
  factoryGate?: string;
  engineRestart?: string;
  engineRecovery?: string;
}

/**
 * Why the switch must not run yet, or null. Every configured Factory gate must already pin the
 * switch's own check (version 4 or later): an older check refuses every restart after a plain
 * boot, so a forgotten re-pin would leave Dev switched with each later restart refused.
 */
export function bootEntrySwitchPinProblem(
  plan: BootEntrySwitchConfiguration,
  pins: FactoryCheckPins,
): string | null {
  const stale = Object.entries(pins)
    .filter(([, sha]) => sha !== undefined && sha !== plan.factoryVerify.sha256)
    .map(([gate]) => gate);
  return stale.length
    ? `${stale.join(", ")} must pin the same Factory check as the switch before it runs`
    : null;
}

/** The first line of a failed command's stderr or message, bounded for a refusal detail. */
function commandError(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  let text = error instanceof Error ? error.message : String(error);
  if (typeof stderr === "string" && stderr.trim()) text = stderr;
  return text.trim().split("\n")[0]!.slice(0, 200);
}

function docker(plan: BootEntrySwitchConfiguration, args: string[]): string[] {
  return ["--host", `unix://${plan.socket}`, ...args];
}

/** Runs a fixed POSIX script inside Dev; plan values arrive only as positional arguments. */
async function inDev(
  plan: BootEntrySwitchConfiguration,
  run: EngineCommand,
  user: "0" | "paseo",
  script: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await run(
    plan.docker,
    docker(plan, ["exec", "--user", user, plan.container, "/bin/sh", "-c", script, "sh", ...args]),
    timeoutMs,
  );
  return stdout;
}

interface ContainerState {
  id: string;
  running: boolean;
  startedAt: string;
  health: string;
}

async function inspectDev(
  plan: BootEntrySwitchConfiguration,
  run: EngineCommand,
): Promise<ContainerState> {
  const { stdout } = await run(
    plan.docker,
    // State as JSON: template lookups fail on containers without a healthcheck.
    docker(plan, [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Id}}|{{json .State}}",
      plan.container,
    ]),
    COMMAND_TIMEOUT_MS,
  );
  const line = stdout.trim();
  const separator = line.indexOf("|");
  const state = JSON.parse(line.slice(separator + 1)) as {
    Running?: unknown;
    StartedAt?: unknown;
    Health?: { Status?: unknown } | null;
  };
  return {
    id: line.slice(0, separator),
    running: state.Running === true,
    startedAt: typeof state.StartedAt === "string" ? state.StartedAt : "",
    health: typeof state.Health?.Status === "string" ? state.Health.Status : "",
  };
}

// sha256 of each argument path, one "<hex> <path>" line each; a missing file prints
// "missing" and one this user cannot read prints "unreadable".
const HASH_FILES = `for f in "$@"; do if [ ! -f "$f" ] || [ -L "$f" ]; then printf 'missing %s\\n' "$f"; elif [ ! -r "$f" ]; then printf 'unreadable %s\\n' "$f"; else printf '%s %s\\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; fi; done`;

/**
 * Reads run as paseo. Dev drops every capability, so its root cannot read past file modes:
 * the managed releases (0700) and the Factory entry (0600) belong to paseo, while the
 * pointer and the installed plain entry are world-readable. Only writes and supervisorctl
 * run as root.
 */
const READER = "paseo";

async function hashes(
  plan: BootEntrySwitchConfiguration,
  run: EngineCommand,
  paths: string[],
): Promise<Map<string, string>> {
  const output = await inDev(plan, run, READER, HASH_FILES, paths);
  const result = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    const space = line.indexOf(" ");
    result.set(line.slice(space + 1), line.slice(0, space));
  }
  return result;
}

const SUPERVISOR_PID = `supervisorctl -c "$1" status "$2" | awk '$2 == "RUNNING" { for (i = 1; i <= NF; i++) if ($i == "pid") { sub(",", "", $(i + 1)); print $(i + 1) } }'`;

async function supervisorPid(plan: BootEntrySwitchConfiguration, run: EngineCommand) {
  const output = await inDev(plan, run, "0", SUPERVISOR_PID, [
    plan.supervisor.config,
    plan.supervisor.program,
  ]);
  const pid = Number(output.trim());
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function factoryCheck(plan: BootEntrySwitchConfiguration, run: EngineCommand) {
  return runFactoryVerify(
    {
      docker: plan.docker,
      socket: plan.socket,
      container: plan.container,
      verify: plan.factoryVerify,
    },
    run,
  );
}

/**
 * Root writes the pointer and, with a source, the target: no other user may control either
 * directory or any directory above it.
 */
async function assertSafeDirectories(
  plan: BootEntrySwitchConfiguration,
  run: EngineCommand,
  refuse: (detail: string) => never,
): Promise<void> {
  const paths: [string, string][] = [[plan.current.pointer.path, "boot pointer"]];
  if (plan.target.source) paths.push([plan.target.path, "target entry"]);
  for (const [path, label] of paths) {
    const verdict = await inDev(plan, run, "0", TARGET_DIRECTORY_CHECK, [path, "0"]).catch(
      (error: unknown) =>
        refuse(`the ${label} directory could not be checked (${commandError(error)})`),
    );
    if (verdict.trim() !== "safe") refuse(`the ${label} directory is unsafe (${verdict.trim()})`);
  }
}

/** Read-only. Refuses before any effect unless the plan matches Dev exactly and Dev is healthy. */
export async function bootEntrySwitchPreflight(
  plan: BootEntrySwitchConfiguration,
  expectedDigest: string,
  dependencies: BootEntrySwitchDependencies = {},
): Promise<BootEntrySwitchPreflight> {
  const run = dependencies.run ?? defaultRun;
  const refuse = (detail: string): never => {
    throw new Error(`Dev boot-entry switch preflight failed: ${detail}. Nothing was changed.`);
  };
  if (bootEntrySwitchPlanDigest(plan) !== expectedDigest)
    refuse("the reviewed plan is unavailable or changed");
  let state: ContainerState;
  try {
    state = await inspectDev(plan, run);
  } catch (error) {
    return refuse(`the Dev container could not be inspected (${commandError(error)})`);
  }
  if (state.id !== plan.container) refuse("the Dev container ID changed");
  if (!state.running) refuse("the Dev container is not running");
  if (state.health !== "healthy") refuse("the Dev container is not healthy");
  const pointerContent = await inDev(plan, run, READER, 'cat "$1"', [
    plan.current.pointer.path,
  ]).catch((error: unknown) =>
    refuse(`the boot pointer could not be read (${commandError(error)})`),
  );
  if (pointerContent !== bootEntryPointerBytes(plan.current.entry.path))
    refuse("the boot pointer does not name the expected current entry");
  const files: [string, string, string][] = [
    [plan.current.pointer.path, plan.current.pointer.sha256, "boot pointer"],
    [plan.current.entry.path, plan.current.entry.sha256, "current boot entry"],
    [plan.node.path, plan.node.sha256, "node runtime"],
    [plan.supervisorEntry.path, plan.supervisorEntry.sha256, "supervisor entry"],
  ];
  if (!plan.target.source)
    files.push([plan.target.path, plan.target.sha256, "retained target entry"]);
  let found: Map<string, string>;
  try {
    found = await hashes(
      plan,
      run,
      files.map(([path]) => path),
    );
  } catch (error) {
    return refuse(`Dev files could not be hashed (${commandError(error)})`);
  }
  for (const [path, expected, label] of files) {
    if (found.get(path) === "unreadable") refuse(`the ${label} is not readable by ${READER}`);
    if (found.get(path) !== expected) refuse(`the ${label} differs from the plan`);
  }
  await assertSafeDirectories(plan, run, refuse);

  const pid = await supervisorPid(plan, run).catch(() => null);
  if (pid === null) refuse(`supervisord program "${plan.supervisor.program}" is not running`);
  const factory = await factoryCheck(plan, run);
  if (!factory.ok) refuse(`Factory check "${factory.check}" failed`);
  if ((factory.bootForm ?? "launcher") === plan.expectBootForm)
    refuse(`Dev already boots in the ${plan.expectBootForm} form`);
  if (bootEntrySwitchPlanDigest(plan) !== expectedDigest)
    refuse("the reviewed plan changed during preflight");
  return { containerStartedAt: state.startedAt, supervisorPid: pid!, factory };
}

/**
 * The scripts run as root but take the owner as arguments: the coordinator always passes
 * uid and gid 0, and tests pass their own so the real scripts run without root.
 *
 * safe_ancestors <dir> <uid>: every existing directory from <dir> up to / is a real
 * directory (not a symlink) owned by root or <uid> and not writable by group or others,
 * unless sticky like /tmp, where others cannot replace entries they do not own. No other
 * user can then redirect a root write. `ls -ldn` reads the same on GNU and BSD.
 */
const SAFE_ANCESTORS = `safe_ancestors() {
  p=$1
  while :; do
    if [ -L "$p" ]; then echo "$p is a symlink"; return 1; fi
    if [ -e "$p" ]; then
      [ -d "$p" ] || { echo "$p is not a directory"; return 1; }
      info=$(ls -ldn "$p")
      owner=$(printf '%s\n' "$info" | awk '{ print $3 }')
      [ "$owner" = 0 ] || [ "$owner" = "$2" ] || { echo "$p is owned by uid $owner"; return 1; }
      case $(printf '%s' "$info" | cut -c1-10) in
        ?????????t) ;;
        ?????w* | ????????w*) echo "$p is writable by group or others"; return 1 ;;
      esac
    fi
    [ "$p" = / ] && return 0
    p=$(dirname "$p")
  done
}`;

/** $1 target path, $2 expected owner uid. Prints "safe" or why the target directory is not. */
export const TARGET_DIRECTORY_CHECK = `${SAFE_ANCESTORS}
if reason=$(safe_ancestors "$(dirname "$1")" "$2"); then echo safe; else echo "$reason"; fi`;

/**
 * $1 target, $2 expected sha256, $3 base64 bytes, $4 uid, $5 gid. A 0644 file via an
 * unpredictable temporary file and a same-directory rename, in a re-checked directory.
 */
export const INSTALL_TARGET = `set -eu
${SAFE_ANCESTORS}
dir=$(dirname "$1")
safe_ancestors "$dir" "$4" >&2 || { echo "target directory is unsafe" >&2; exit 1; }
install -d -o "$4" -g "$5" -m 0755 "$dir"
safe_ancestors "$dir" "$4" >&2 || { echo "target directory is unsafe" >&2; exit 1; }
tmp=$(mktemp "$dir/.boot-entry.XXXXXX"); trap 'rm -f "$tmp"' EXIT
printf '%s' "$3" | base64 -d > "$tmp"
chown "$4:$5" "$tmp"; chmod 0644 "$tmp"; sync "$tmp"
[ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$2" ] || { echo "target entry digest differs after copy" >&2; exit 1; }
mv -f "$tmp" "$1"; sync "$dir"; trap - EXIT`;

/**
 * $1 pointer, $2 expected current sha256, $3 backup suffix, $4 new pointer bytes,
 * $5 expected new sha256, $6 uid, $7 gid. The backup must not exist yet, and the new
 * pointer goes through an unpredictable temporary file and a same-directory rename.
 */
export const SWAP_POINTER = `set -eu
${SAFE_ANCESTORS}
dir=$(dirname "$1"); backup="$1.before-boot-switch-$3"
safe_ancestors "$dir" "$6" >&2 || { echo "boot pointer directory is unsafe" >&2; exit 1; }
{ [ -f "$1" ] && [ ! -L "$1" ]; } || { echo "boot pointer is not a regular file" >&2; exit 1; }
[ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || { echo "boot pointer changed before the swap" >&2; exit 1; }
{ [ ! -e "$backup" ] && [ ! -L "$backup" ]; } || { echo "boot pointer backup already exists" >&2; exit 1; }
cp -p "$1" "$backup"
tmp=$(mktemp "$dir/.boot-pointer.XXXXXX"); trap 'rm -f "$tmp"' EXIT
printf '%s' "$4" > "$tmp"; chown "$6:$7" "$tmp"; chmod 0644 "$tmp"; sync "$tmp"
[ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$5" ] || { echo "new boot pointer digest differs" >&2; exit 1; }
mv -f "$tmp" "$1"; sync "$dir"; trap - EXIT`;

/**
 * The effects, in order: install the target entry when the plan carries it, then swap the
 * pointer against its expected digest, keeping a backup named for the job. Nothing has
 * restarted yet; a failure here leaves the old pointer or the verified new one in place.
 */
export async function applyBootEntrySwitch(
  plan: BootEntrySwitchConfiguration,
  jobId: string,
  dependencies: BootEntrySwitchDependencies = {},
): Promise<string> {
  const run = dependencies.run ?? defaultRun;
  const source = readTargetSource(plan);
  if (source)
    await inDev(plan, run, "0", INSTALL_TARGET, [
      plan.target.path,
      plan.target.sha256,
      source.toString("base64"),
      "0",
      "0",
    ]).catch((error: unknown) => {
      throw new Error(
        `Dev boot-entry switch could not install the target entry (${commandError(error)}). The boot pointer was not changed.`,
      );
    });
  const pointer = bootEntryPointerBytes(plan.target.path);
  await inDev(plan, run, "0", SWAP_POINTER, [
    plan.current.pointer.path,
    plan.current.pointer.sha256,
    jobId.replace(/[^A-Za-z0-9-]/g, ""),
    pointer,
    sha256(pointer),
    "0",
    "0",
  ]).catch((error: unknown) => {
    throw new Error(
      `Dev boot-entry switch could not swap the boot pointer (${commandError(error)}). Inspect it before any new request; nothing will be retried.`,
    );
  });
  return `${plan.current.pointer.path}.before-boot-switch-${jobId.replace(/[^A-Za-z0-9-]/g, "")}`;
}

/** Restarts the supervisord program so the boot pointer is read again. */
export async function restartBootProgram(
  plan: BootEntrySwitchConfiguration,
  dependencies: BootEntrySwitchDependencies = {},
): Promise<void> {
  const run = dependencies.run ?? defaultRun;
  try {
    await inDev(
      plan,
      run,
      "0",
      'supervisorctl -c "$1" restart "$2"',
      [plan.supervisor.config, plan.supervisor.program],
      (plan.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS) * 1000,
    );
  } catch (error) {
    throw new Error(
      `The boot pointer was switched, but restarting "${plan.supervisor.program}" failed (${commandError(error)}). Inspect Dev before any new request; nothing will be retried.`,
      { cause: error },
    );
  }
}

// As paseo (the supervisor's user), so /proc environ is readable without extra capabilities.
// $1 pid. Prints the NUL-separated cmdline and environment as lines.
const PROCESS_FACTS = `tr '\\0' '\\n' < "/proc/$1/cmdline"; echo '--environ--'; tr '\\0' '\\n' < "/proc/$1/environ"`;

/** Why the new boot is not yet acceptable, or "" when it is. */
async function readinessGap(
  plan: BootEntrySwitchConfiguration,
  preflight: BootEntrySwitchPreflight,
  run: EngineCommand,
): Promise<string> {
  let state: ContainerState;
  try {
    state = await inspectDev(plan, run);
  } catch {
    return "the Dev container exists";
  }
  if (state.id !== plan.container || !state.running) return "the Dev container runs";
  const pid = await supervisorPid(plan, run).catch(() => null);
  if (pid === null) return `supervisord program "${plan.supervisor.program}" runs`;
  if (pid === preflight.supervisorPid) return "a new Dev supervisor started";
  let facts: string;
  try {
    facts = await inDev(plan, run, "paseo", PROCESS_FACTS, [String(pid)]);
  } catch {
    return "the new Dev supervisor can be inspected";
  }
  const [cmdline = "", environ = ""] = facts.split("--environ--\n");
  const argv = cmdline.split("\n").filter(Boolean);
  if (argv[0] !== plan.node.path || argv[1] !== plan.supervisorEntry.path)
    return "the new supervisor runs the pinned node and supervisor entry";
  const env = new Set(environ.split("\n").filter(Boolean));
  if (
    !env.has("PASEO_MANAGED_RELEASE_ROOT=/opt/vorteo-managed-releases") ||
    !env.has("PASEO_MANAGED_RELEASE_LINK=/opt/vorteo-managed-releases/current")
  )
    return "the new supervisor has the managed release environment";
  const governed = [...env].some((line) => line.startsWith("PASEO_GOVERNED_RUNTIME_MODULE="));
  if (plan.expectBootForm === "plain" && governed)
    return "the new supervisor runs without Factory's runtime";
  if (plan.expectBootForm === "launcher" && !governed)
    return "the new supervisor runs with Factory's runtime";
  if (state.health !== "healthy") return "the Dev container is healthy";
  return "";
}

/** Bounded and read-only: the new supervisor runs exactly the target boot, and Dev is healthy. */
export async function awaitBootEntryReadiness(
  plan: BootEntrySwitchConfiguration,
  preflight: BootEntrySwitchPreflight,
  dependencies: BootEntrySwitchDependencies = {},
): Promise<string[]> {
  const run = dependencies.run ?? defaultRun;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const now = dependencies.now ?? Date.now;
  const seconds = plan.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
  const deadline = now() + seconds * 1000;
  let unmet = "the Dev container runs";
  while (now() < deadline) {
    unmet = await readinessGap(plan, preflight, run);
    if (!unmet) {
      const pointer = await hashes(plan, run, [plan.current.pointer.path]);
      if (
        pointer.get(plan.current.pointer.path) !== sha256(bootEntryPointerBytes(plan.target.path))
      )
        throw new Error(
          "Dev restarted, but the boot pointer no longer names the target entry. Inspect Dev; nothing will be retried.",
        );
      return [
        "boot pointer names the target entry",
        "new Dev supervisor runs the pinned node and supervisor entry",
        plan.expectBootForm === "plain"
          ? "supervisor environment has no Factory runtime"
          : "supervisor environment has Factory's runtime",
        "Dev container healthy",
      ];
    }
    await sleep(5000);
  }
  throw new Error(
    `The boot pointer was switched and Dev restarted, but ${unmet} was not met within ${seconds} s. Dev turns stay held until Dev answers; nothing will be retried.`,
  );
}

/** Factory reports the expected boot form, with its owner pause and custody unchanged. */
export async function verifyFactoryAfterBootSwitch(
  plan: BootEntrySwitchConfiguration,
  preflight: BootEntrySwitchPreflight,
  dependencies: BootEntrySwitchDependencies = {},
): Promise<string> {
  const after = await factoryCheck(plan, dependencies.run ?? defaultRun);
  if (!after.ok)
    throw new Error(
      `Dev restarted, but Factory check "${after.check}" failed. Factory review is required; nothing will be retried.`,
    );
  if ((after.bootForm ?? "launcher") !== plan.expectBootForm)
    throw new Error(
      `Dev restarted, but Factory reports the ${after.bootForm ?? "launcher"} boot form, not ${plan.expectBootForm}. Factory review is required; nothing will be retried.`,
    );
  const { problems } = compareFactoryFacts(preflight.factory, after, "boot-switch");
  if (problems.length)
    throw new Error(
      `Dev restarted, but ${problems.join("; ")}. Factory review is required; nothing will be retried.`,
    );
  return plan.expectBootForm === "plain"
    ? `Factory confirms Dev boots without its launcher (owner ${after.ownerMode} ${after.ownerSequence}, ${after.custodyCount} custody records unchanged)`
    : `Factory accepted its lock again (epoch ${after.epoch ?? "unknown"})`;
}
