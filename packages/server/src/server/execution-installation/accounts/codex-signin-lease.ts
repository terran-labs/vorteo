import { randomUUID } from "node:crypto";

/** The daemon ends every lease after this long, whatever the coordinator does. */
export const CODEX_REFRESH_LEASE_MS = 30_000;

export interface CodexRefreshLease {
  leaseId: string;
  expiresAt: number;
  /** A session on the account is loaded but idle. */
  loaded: boolean;
}

interface HeldLease {
  leaseId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  released: Promise<void>;
  release(): void;
}

interface LeaseOptions {
  /** `busy` while a session on this provider starts or runs a turn; `loaded` while one is idle. */
  activity(providerId: string): "busy" | "loaded" | "none";
  now?: () => number;
}

/**
 * Host daemon side of the coordinator's Codex refresh. The Host's own Codex sessions are the
 * normal refresh writer, and Codex does not lock the network refresh across processes. A loaded
 * Codex refreshes only while one of its requests runs inside the token's last five minutes, and
 * it rereads `auth.json` first. The daemon therefore grants a lease unless a session on the
 * account is starting or running a turn, and reports whether an idle one is loaded so the
 * coordinator can leave the last minutes to it. While a lease is held, new sessions on that
 * account wait, at most until the lease ends by itself. Turns on loaded sessions are not held.
 */
export class CodexRefreshLeases {
  private readonly leases = new Map<string, HeldLease>();
  private readonly now: () => number;

  constructor(private readonly options: LeaseOptions) {
    this.now = options.now ?? Date.now;
  }

  acquire(providerId: string): CodexRefreshLease | null {
    if (this.leases.has(providerId)) return null;
    const activity = this.options.activity(providerId);
    if (activity === "busy") return null;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lease: HeldLease = {
      leaseId: randomUUID(),
      expiresAt: this.now() + CODEX_REFRESH_LEASE_MS,
      released,
      release,
      timer: setTimeout(() => this.end(providerId, lease.leaseId), CODEX_REFRESH_LEASE_MS),
    };
    lease.timer.unref?.();
    this.leases.set(providerId, lease);
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt, loaded: activity === "loaded" };
  }

  /**
   * Leases every provider, all or none, and returns their release; null when any of them is
   * busy or already leased, after releasing the ones it took.
   */
  acquireAll(providerIds: readonly string[]): (() => void) | null {
    const held: Array<{ providerId: string; leaseId: string }> = [];
    const release = () => {
      for (const item of held.splice(0)) this.end(item.providerId, item.leaseId);
    };
    for (const providerId of providerIds) {
      const lease = this.acquire(providerId);
      if (!lease) {
        release();
        return null;
      }
      held.push({ providerId, leaseId: lease.leaseId });
    }
    return release;
  }

  release(providerId: string, leaseId: string): void {
    this.end(providerId, leaseId);
  }

  /** Undefined when no lease is held, so session starts without a lease never wait. */
  hold(providerId: string): Promise<void> | undefined {
    return this.leases.get(providerId)?.released;
  }

  private end(providerId: string, leaseId: string): void {
    const lease = this.leases.get(providerId);
    if (lease?.leaseId !== leaseId) return;
    clearTimeout(lease.timer);
    this.leases.delete(providerId);
    lease.release();
  }
}
