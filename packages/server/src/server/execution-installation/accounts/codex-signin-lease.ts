import { randomUUID } from "node:crypto";

/** The daemon ends every lease after this long, whatever the coordinator does. */
export const CODEX_REFRESH_LEASE_MS = 30_000;

export interface CodexRefreshLease {
  leaseId: string;
  expiresAt: number;
}

interface HeldLease extends CodexRefreshLease {
  timer: ReturnType<typeof setTimeout>;
  released: Promise<void>;
  release(): void;
}

interface LeaseOptions {
  /** Whether an agent session, or one being registered, uses this provider ID. */
  inUse(providerId: string): boolean;
  now?: () => number;
}

/**
 * Host daemon side of the coordinator's Codex refresh. The Host's own Codex sessions are the
 * normal refresh writer, and Codex does not lock the network refresh across processes. The
 * coordinator therefore refreshes an account only while it holds a lease, which the daemon grants
 * only when no session uses that account. While it is held, new sessions on that account wait,
 * at most until the lease ends by itself.
 */
export class CodexRefreshLeases {
  private readonly leases = new Map<string, HeldLease>();
  private readonly now: () => number;

  constructor(private readonly options: LeaseOptions) {
    this.now = options.now ?? Date.now;
  }

  acquire(providerId: string): CodexRefreshLease | null {
    if (this.leases.has(providerId) || this.options.inUse(providerId)) return null;
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
    return { leaseId: lease.leaseId, expiresAt: lease.expiresAt };
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
