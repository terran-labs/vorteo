import type { PhysicalTrafficOutcome } from "./runtime-metrics.js";

// OOM backstop for a socket whose client stopped draining. A daemon normally has
// 1-10 physical sockets (tens at the outside), so 64 MiB bounds abandoned queues
// without treating ordinary large frames as a protocol or frame-size violation.
export const MAX_PHYSICAL_SOCKET_BUFFERED_BYTES = 64 * 1024 * 1024;
// Current clients ping every 10 seconds. Four delayed cycles fit inside the
// lease without making an abandoned application socket linger for minutes.
export const APPLICATION_SOCKET_LEASE_MS = 45_000;
export const APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS = 10_000;

type Clock = () => number;

export class ApplicationSocketLease<TSocket extends object> {
  private readonly deadlines = new Map<TSocket, number>();

  constructor(private readonly clock: Clock = Date.now) {}

  claim(socket: TSocket): void {
    this.deadlines.set(socket, this.clock() + APPLICATION_SOCKET_LEASE_MS);
  }

  renew(socket: TSocket): void {
    if (this.deadlines.has(socket)) {
      this.claim(socket);
    }
  }

  release(socket: TSocket): void {
    this.deadlines.delete(socket);
  }

  listExpired(): TSocket[] {
    const now = this.clock();
    const expired: TSocket[] = [];
    for (const [socket, deadline] of this.deadlines) {
      if (deadline > now) continue;
      expired.push(socket);
    }
    return expired;
  }

  clear(): void {
    this.deadlines.clear();
  }
}

export function outboundFrameByteLength(data: string | Uint8Array | ArrayBuffer): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  return data.byteLength;
}

interface BoundedPhysicalSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
}

export async function sendBoundedPhysicalFrameAndWait(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
  observe?: (outcome: PhysicalTrafficOutcome, bytes: number) => void;
}): Promise<boolean> {
  const { socket, frame, frameBytes = outboundFrameByteLength(frame), onHighWater } = params;
  const observe = safeObserver(params.observe);
  observe?.("attempted", frameBytes);
  if (socket.readyState !== 1) {
    observe?.("rejected", frameBytes);
    return false;
  }
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    observe?.("rejected", frameBytes);
    onHighWater();
    return false;
  }

  let completionObserved = false;
  const complete = (outcome: PhysicalTrafficOutcome) => {
    if (completionObserved) return;
    completionObserved = true;
    observe?.(outcome, frameBytes);
  };
  await new Promise<void>((resolve, reject) => {
    let callbackUsed = false;
    let result: void | Promise<void>;
    try {
      result = socket.send(frame, (error) => {
        callbackUsed = true;
        if (error) reject(error);
        else resolve();
        complete(error ? "failed" : "completed");
      });
    } catch (error) {
      reject(error);
      observe?.("rejected", frameBytes);
      return;
    }
    observe?.("accepted", frameBytes);
    if (result && typeof result.then === "function") {
      void result
        .then(
          () => {
            resolve();
            return complete("completed");
          },
          (error) => {
            reject(error);
            complete("failed");
          },
        )
        .catch(reject);
    } else if (socket.send.length < 2 && !callbackUsed) {
      resolve();
      complete("completionUnknown");
    }
  });
  return true;
}

export function physicalSocketHasCapacity(
  socket: Pick<BoundedPhysicalSocket, "bufferedAmount">,
  frameBytes: number,
): boolean {
  if (typeof socket.bufferedAmount !== "number") return true;
  return socket.bufferedAmount + frameBytes <= MAX_PHYSICAL_SOCKET_BUFFERED_BYTES;
}

export function sendBoundedPhysicalFrame(params: {
  socket: BoundedPhysicalSocket;
  frame: string | Uint8Array | ArrayBuffer;
  frameBytes?: number;
  onHighWater: () => void;
  observe?: (outcome: PhysicalTrafficOutcome, bytes: number) => void;
}): boolean {
  const { socket, frame, frameBytes = outboundFrameByteLength(frame), onHighWater } = params;
  const observe = safeObserver(params.observe);
  observe?.("attempted", frameBytes);
  if (socket.readyState !== 1) {
    observe?.("rejected", frameBytes);
    return false;
  }
  if (!physicalSocketHasCapacity(socket, frameBytes)) {
    observe?.("rejected", frameBytes);
    onHighWater();
    return false;
  }
  let result: void | Promise<void>;
  try {
    result = socket.send(frame);
  } catch (error) {
    observe?.("rejected", frameBytes);
    throw error;
  }
  observe?.("accepted", frameBytes);
  if (result && typeof result.then === "function") {
    void result
      .then(
        () => observe?.("completed", frameBytes),
        () => observe?.("failed", frameBytes),
      )
      .catch(() => undefined);
  } else {
    // Ordinary sends do not request callbacks. Preserve that transport contract.
    observe?.("completionUnknown", frameBytes);
  }
  return true;
}

// Observers are synchronous diagnostics. Their failures cannot settle or reject a send.
function safeObserver(
  observe: ((outcome: PhysicalTrafficOutcome, bytes: number) => void) | undefined,
) {
  return (outcome: PhysicalTrafficOutcome, bytes: number): void => {
    try {
      observe?.(outcome, bytes);
    } catch {
      // The metrics collector counts its own failures; arbitrary observers stay isolated too.
    }
  };
}
