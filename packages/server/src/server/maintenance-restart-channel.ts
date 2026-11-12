/** IPC transport only. Queue authority, exact held-worker admission and native
 * readiness remain mandatory outside this channel. */
export interface MaintenanceRestartIntent {
  requestId: string;
  generation: string;
  workerPid: number;
  terminateAt: number;
}
export interface MaintenanceRestartAcceptance extends MaintenanceRestartIntent {
  accepted: true;
}
interface ChannelPorts {
  workerPid: number;
  parentPid: number;
  currentParentPid(): number;
  connected(): boolean;
  send(message: MaintenanceRestartIntent & { type: "paseo:maintenance-restart" }): void;
  now(): number;
}

export interface MaintenanceRestartBridge {
  supported(): boolean;
  request(intent: MaintenanceRestartIntent): Promise<MaintenanceRestartAcceptance>;
}

export function createMaintenanceRestartChannel(ports: ChannelPorts) {
  let protocol = false;
  let consumed = false;
  const attemptedGenerations = new Set<string>();
  let pending: {
    intent: MaintenanceRestartIntent;
    resolve(value: MaintenanceRestartAcceptance): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const supported = () =>
    protocol && ports.connected() && ports.currentParentPid() === ports.parentPid;

  function observe(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const message = value as Record<string, unknown>;
    if (message.type === "paseo:supervisor-heartbeat") {
      protocol = message.maintenanceRestartProtocol === 1;
      return;
    }
    if (message.type !== "paseo:maintenance-restart-accepted" || !pending || !supported()) return;
    const { intent } = pending;
    if (
      message.requestId !== intent.requestId ||
      message.generation !== intent.generation ||
      message.workerPid !== intent.workerPid ||
      message.terminateAt !== intent.terminateAt ||
      typeof message.accepted !== "boolean"
    )
      return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (!message.accepted) {
      // An exact refusal proves that this supervisor did not dispatch. A new
      // tracked generation may proceed; the refused generation cannot be resent.
      consumed = false;
      current.reject(new Error("Supervisor refused the exact maintenance restart"));
    } else current.resolve({ ...intent, accepted: true });
  }

  function request(intent: MaintenanceRestartIntent): Promise<MaintenanceRestartAcceptance> {
    if (!supported())
      return Promise.reject(new Error("Running supervisor lacks maintenance restart support"));
    if (consumed)
      return Promise.reject(
        new Error("Maintenance restart was already attempted; observe without replay"),
      );
    if (attemptedGenerations.has(intent.generation))
      return Promise.reject(
        new Error("Maintenance generation was already attempted; do not resend"),
      );
    const remaining = intent.terminateAt - ports.now();
    if (
      intent.workerPid !== ports.workerPid ||
      !Number.isSafeInteger(intent.terminateAt) ||
      remaining <= 0 ||
      remaining > 300_000
    )
      return Promise.reject(
        new Error("Maintenance restart differs from the current worker or deadline"),
      );
    consumed = true;
    attemptedGenerations.add(intent.generation);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending = null;
          reject(new Error("Supervisor acceptance is unconfirmed; observe without replay"));
        },
        Math.min(5000, remaining),
      );
      pending = { intent: { ...intent }, resolve, reject, timer };
      try {
        ports.send({ ...intent, type: "paseo:maintenance-restart" });
      } catch (error) {
        clearTimeout(timer);
        pending = null;
        reject(
          new Error("Maintenance restart send is unconfirmed; observe without replay", {
            cause: error,
          }),
        );
      }
    });
  }
  return { supported, observe, request };
}

/** Private preparation IPC. Only the verified supervisor mailbox consumer sends
 * this message; an ordinary daemon client has no route to this handler. */
export async function handleCooperativeDrainMessage(
  value: unknown,
  ports: {
    parentPid: number;
    currentParentPid(): number;
    connected(): boolean;
    workerPid: number;
    manager: Pick<
      import("./agent/agent-manager.js").AgentManager,
      "interruptRestartDrain" | "getRestartImpact"
    >;
    send(message: object): void;
  },
): Promise<boolean> {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "paseo:cooperative-drain-prepare"
  )
    return false;
  const { CooperativeDrainPreparationSchema } =
    await import("@getpaseo/protocol/maintenance-interruption");
  const parsed = CooperativeDrainPreparationSchema.safeParse(
    (value as { reservation?: unknown }).reservation,
  );
  if (!parsed.success || !ports.connected() || ports.currentParentPid() !== ports.parentPid)
    return true;
  const reservation = parsed.data;
  const held = reservation.intent.held;
  const impact = ports.manager.getRestartImpact();
  if (
    reservation.phase !== "reserved" ||
    held.workerPid !== ports.workerPid ||
    reservation.intent.native.supervisor.pid !== ports.parentPid ||
    reservation.intent.native.worker.pid !== ports.workerPid ||
    reservation.intent.native.worker.parentPid !== ports.parentPid ||
    impact.workerInstanceId !== held.workerInstanceId ||
    impact.restartDrainId !== held.requestId
  )
    return true;
  const reply = (state: "accepted" | "settled" | "unknown") => {
    if (ports.connected() && ports.currentParentPid() === ports.parentPid)
      ports.send({
        type: "paseo:cooperative-drain-observation",
        requestId: held.requestId,
        generation: held.generation,
        workerInstanceId: held.workerInstanceId,
        state,
      });
  };
  reply("accepted");
  try {
    // The manager retains this attempt for the worker lifetime and waits for
    // genuine terminal events. An acknowledgement cannot manufacture settlement.
    await ports.manager.interruptRestartDrain(held);
    const settled = ports.manager.getRestartImpact();
    const idle =
      settled.workerInstanceId === held.workerInstanceId &&
      settled.restartDrainId === held.requestId &&
      settled.agents.length === 0 &&
      settled.pendingStarts === 0;
    reply(idle ? "settled" : "unknown");
  } catch {
    reply("unknown");
  }
  return true;
}

export interface CooperativeMailboxOptions {
  readerUid: number;
  scopeFile: string;
  endpointIdentitySha256: string;
  ownerUid: number;
  helperFile: string;
  helperSha256: string;
  pythonFile: "/usr/bin/python3";
}

/** Reads root/native-owned immutable commands via the pinned fixed helper.
 * Kernel parent/birth checks occur in that helper, whose parent is this process.
 * Nothing in this reader publishes, provisions, or grants a preparation. */
export async function readCooperativeMailbox(options: CooperativeMailboxOptions) {
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { CooperativeDrainPreparationSchema } =
    await import("@getpaseo/protocol/maintenance-interruption");
  const file = await fs.promises.open(
    options.helperFile,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let source: Buffer;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== options.ownerUid ||
      (stat.mode & 0o022) !== 0 ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > 32768
    )
      throw new Error("Cooperative helper custody differs from the native descriptor");
    source = await file.readFile();
    if (createHash("sha256").update(source).digest("hex") !== options.helperSha256)
      throw new Error("Cooperative helper source differs from the native descriptor");
  } finally {
    await file.close();
  }
  const result = await promisify(execFile)(
    options.pythonFile,
    [
      "-I",
      "-B",
      "-c",
      source.toString("utf8"),
      "consume",
      "--scope",
      options.scopeFile,
      "--endpoint-sha256",
      options.endpointIdentitySha256,
      "--owner-uid",
      String(options.ownerUid),
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    },
  );
  const values: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(values) || values.length > 16)
    throw new Error("Cooperative mailbox observation exceeds its entry budget");
  return values.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid cooperative envelope");
    const envelope = value as Record<string, unknown>;
    if (
      envelope.operation !== "maintenance.interrupt-held-turns" ||
      envelope.endpointIdentitySha256 !== options.endpointIdentitySha256
    )
      throw new Error("Cooperative envelope endpoint differs");
    return CooperativeDrainPreparationSchema.parse(envelope.reservation);
  });
}
