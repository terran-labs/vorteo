import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Same file name the daemon reads; see packages/server/src/server/session-host/settings.ts. */
export const DURABLE_SESSIONS_SETTINGS_FILE = "durable-sessions.json";

const POLL_MS = 5_000;
/** The owner has this long to approve the install before the step stops waiting. */
const DEFAULT_APPROVAL_WAIT_MS = 30 * 60_000;
const FAILED = new Set(["failed", "rejected"]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Writes `{"enabled": true}` only when no setting exists, so an owner's explicit choice, on or off,
 * always survives a rerun. Linking a finished temporary file is atomic and fails if the target
 * already exists, so the daemon never reads a partial file and a racing writer is never replaced.
 */
export function writeDurableSessionsSettingIfMissing(paseoHome) {
  const target = path.join(paseoHome, DURABLE_SESSIONS_SETTINGS_FILE);
  const temporary = path.join(paseoHome, `.${DURABLE_SESSIONS_SETTINGS_FILE}.${randomUUID()}`);
  writeFileSync(temporary, '{"enabled": true}\n', { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, target);
    return { written: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { written: false };
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** The installation's record and Host client, refusing before any change when setup is incomplete. */
function readSetup(root) {
  const record = readJson(path.join(root, "installation.json"));
  if (record.phase !== "started")
    throw new Error("Finish installing this installation before turning on durable sessions.");
  const config = readJson(record.configFile);
  if (!config.sourceUpdates?.currentReleaseLink || !config.host?.startupValidation)
    throw new Error(
      "Durable sessions need Host source updates through the current release link. Complete the one-time Host setup in docs/execution-installation.md first; nothing was changed.",
    );
  return { record, client: readJson(path.join(root, "host-agent.json")) };
}

/** A JSON call to the coordinator with the trusted Host client's token. */
function coordinatorCaller(client, fetchImpl) {
  return async (resource, init = {}) => {
    const response = await fetchImpl(new URL(resource, client.origin), {
      ...init,
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const detail = typeof failure?.error === "string" ? `: ${failure.error}` : "";
      throw new Error(`The coordinator refused ${resource} (${response.status})${detail}`);
    }
    return response.json();
  };
}

/** Opens the install request, or resumes the given one, and waits for its recorded outcome. */
async function installSessionHostJob({ call, client, requestId, sleep, now, log, approvalWaitMs }) {
  let job;
  if (requestId) job = await call(`/api/installation/session-host-requests/${requestId}`);
  else {
    job = await call("/api/installation/session-host-requests", {
      method: "POST",
      body: JSON.stringify({
        id: randomUUID(),
        operation: "session-host-install",
        reason: "Turns on durable sessions as part of Host setup.",
      }),
    });
    const review = new URL("/settings/general", new URL(client.publicOrigin ?? client.origin));
    review.searchParams.set("installation", "1");
    review.searchParams.set("sessionHost", job.id);
    log(`Approve the session host install in Installation controls: ${review.href}`);
  }
  if (job.operation !== "session-host-install")
    throw new Error(`Request ${job.id} does not install the session host job.`);
  const deadline = now() + approvalWaitMs;
  while (job.status !== "succeeded") {
    if (FAILED.has(job.status))
      throw new Error(
        `The session host install ${job.status === "rejected" ? "was declined" : "failed"}; durable sessions stay off. Inspect request ${job.id} in Installation controls.`,
      );
    if (now() >= deadline)
      throw new Error(
        `The session host install is still ${job.status}. Durable sessions stay off; run this step again with --request ${job.id} after approving it.`,
      );
    await sleep(POLL_MS);
    job = await call(`/api/installation/session-host-requests/${job.id}`);
  }
  log("The session host job is installed and its host answered.");
}

/**
 * Turns durable sessions on for a Host installation: installs the coordinator's session host job
 * through the owner-approved request, then writes the setting if none exists. The job must answer
 * before the setting turns on, so no worker ever waits for a host that is not there.
 */
export async function enableDurableSessions({
  root,
  requestId,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = (line) => process.stdout.write(`${line}\n`),
  approvalWaitMs = DEFAULT_APPROVAL_WAIT_MS,
}) {
  const { record, client } = readSetup(root);
  const call = coordinatorCaller(client, fetchImpl);
  const capabilities = await call("/api/installation/capabilities");
  if (capabilities.sessionHostJob?.available !== true)
    throw new Error(
      "The coordinator does not offer the session host job yet. Check that the selected Host release contains the session host; nothing was changed.",
    );

  const before = await call("/api/installation/session-host");
  if (before.installed && before.detail?.plist !== "matching")
    throw new Error(
      "A different session host job is installed. Remove it from Installation controls, then run this step again.",
    );
  const jobReady = before.installed && before.detail?.loaded === true;
  if (jobReady) log("The session host job is already installed.");
  else await installSessionHostJob({ call, client, requestId, sleep, now, log, approvalWaitMs });

  const { written } = writeDurableSessionsSettingIfMissing(record.hostHome);
  const after = await call("/api/installation/session-host");
  if (!after.detail?.host)
    throw new Error(
      "The session host does not answer. Inspect its status in Installation controls.",
    );
  if (after.detail.settingEnabled) {
    log(written ? "Durable sessions are on." : "Durable sessions were already on.");
    return { jobInstalled: !jobReady, settingWritten: written, enabled: true };
  }
  if (written) throw new Error("The durable sessions setting was written but reads as off.");
  log(
    `Durable sessions stay off: ${path.join(record.hostHome, DURABLE_SESSIONS_SETTINGS_FILE)} already sets them, and this step never overrides it.`,
  );
  return { jobInstalled: !jobReady, settingWritten: false, enabled: false };
}
