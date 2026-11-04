import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentGrant, ServicePrincipal } from "@getpaseo/protocol/messages";
import { AgentGrantSchema, DaemonPermissionSchema } from "@getpaseo/protocol/messages";
import { writePrivateFileAtomic } from "../private-files.js";
import { parseDaemonPermissions, type DaemonPermission } from "./index.js";
import { GRANTABLE_SERVICE_PERMISSIONS } from "./service-restrictions.js";

const FILE_NAME = "service-principals.json";
const TOKEN_PREFIX = "pvsc";
const ID_PATTERN = /^[0-9a-f]{16}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const StoredPrincipalSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  label: z.string().min(1),
  permissions: z.array(DaemonPermissionSchema),
  grants: z.array(AgentGrantSchema).default([]),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  // SHA-256 of the secret. Secrets are 256 random bits, so a slow hash adds nothing.
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const StoreFileSchema = z.object({
  version: z.literal(1),
  principals: z.array(StoredPrincipalSchema),
});

type StoredPrincipal = z.infer<typeof StoredPrincipalSchema>;

export class ServicePrincipalError extends Error {}

export interface ServicePrincipalAdmission {
  principalId: string;
  permissions: readonly DaemonPermission[];
  grants: readonly AgentGrant[];
}

const MAX_GRANT_TARGETS = 100;

/** Rejects grants that name no agent or workspace, or that would be unbounded. */
function validateGrants(grants: readonly AgentGrant[]): AgentGrant[] {
  return grants.map((grant) => {
    const agentIds = [...new Set(grant.agentIds ?? [])];
    const workspaceIds = [...new Set(grant.workspaceIds ?? [])];
    if (agentIds.length + workspaceIds.length === 0)
      throw new ServicePrincipalError("Each grant must name at least one agent or workspace");
    if (agentIds.length + workspaceIds.length > MAX_GRANT_TARGETS)
      throw new ServicePrincipalError(`A grant can name at most ${MAX_GRANT_TARGETS} targets`);
    return {
      actions: [...new Set(grant.actions)],
      ...(agentIds.length ? { agentIds } : {}),
      ...(workspaceIds.length ? { workspaceIds } : {}),
    };
  });
}

/** Session principal IDs are namespaced so a service ID can never collide with "owner" or a Hub principal. */
export function servicePrincipalSessionId(id: string): string {
  return `service:${id}`;
}

/**
 * Daemon-owned store of non-interactive principals. Each has a label, the
 * permissions the owner chose, and one bearer credential whose secret is shown
 * once and persisted only as a hash. Revoked principals stay listed for audit.
 */
export class ServicePrincipalStore {
  private readonly filePath: string;
  private principals: StoredPrincipal[] | null = null;
  // Loads and writes run one at a time so concurrent changes never drop each other.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, fileName: string = FILE_NAME) {
    this.filePath = join(directory, fileName);
  }

  list(): Promise<ServicePrincipal[]> {
    return this.serialize(async (principals) => principals.map(toPublic));
  }

  create(input: {
    label: string;
    permissions: readonly DaemonPermission[];
    grants?: readonly AgentGrant[];
  }): Promise<{ principal: ServicePrincipal; token: string }> {
    return this.serialize(async (principals) => {
      const label = input.label.trim();
      if (!label || label.length > 120)
        throw new ServicePrincipalError(
          "A service principal needs a label of up to 120 characters",
        );
      const permissions = parseDaemonPermissions(input.permissions);
      const grants = validateGrants(input.grants ?? []);
      if (permissions.length === 0 && grants.length === 0)
        throw new ServicePrincipalError("A service principal needs a permission or a grant");
      const forbidden = permissions.filter((p) => !GRANTABLE_SERVICE_PERMISSIONS.includes(p));
      if (forbidden.length > 0)
        throw new ServicePrincipalError(
          `Service principals cannot hold ${forbidden.join(", ")} yet; only ${GRANTABLE_SERVICE_PERMISSIONS.join(", ")} is available`,
        );
      const id = randomBytes(8).toString("hex");
      const secret = randomBytes(32).toString("base64url");
      const record: StoredPrincipal = {
        id,
        label,
        permissions,
        grants,
        createdAt: new Date().toISOString(),
        revokedAt: null,
        secretHash: hashSecret(secret),
      };
      await this.persist([...principals, record]);
      return { principal: toPublic(record), token: `${TOKEN_PREFIX}.${id}.${secret}` };
    });
  }

  revoke(id: string): Promise<ServicePrincipal> {
    return this.serialize(async (principals) => {
      const existing = principals.find((principal) => principal.id === id);
      if (!existing) throw new ServicePrincipalError(`Unknown service principal ${id}`);
      if (existing.revokedAt) return toPublic(existing);
      const revoked = { ...existing, revokedAt: new Date().toISOString() };
      await this.persist(
        principals.map((principal) => (principal.id === id ? revoked : principal)),
      );
      return toPublic(revoked);
    });
  }

  /** Replaces a principal's agent grants. Live sessions keep their grants until they reconnect. */
  setGrants(id: string, grants: readonly AgentGrant[]): Promise<ServicePrincipal> {
    return this.serialize(async (principals) => {
      const existing = principals.find((principal) => principal.id === id);
      if (!existing) throw new ServicePrincipalError(`Unknown service principal ${id}`);
      if (existing.revokedAt) throw new ServicePrincipalError("This service principal is revoked");
      const updated = { ...existing, grants: validateGrants(grants) };
      await this.persist(
        principals.map((principal) => (principal.id === id ? updated : principal)),
      );
      return toPublic(updated);
    });
  }

  /** Resolves a presented token to its principal, or null for malformed, unknown or revoked tokens. */
  authenticate(token: string): Promise<ServicePrincipalAdmission | null> {
    const [prefix, id, secret, ...rest] = token.split(".");
    if (prefix !== TOKEN_PREFIX || rest.length > 0) return Promise.resolve(null);
    if (!id || !ID_PATTERN.test(id) || !secret || !SECRET_PATTERN.test(secret))
      return Promise.resolve(null);
    return this.serialize(async (principals) => {
      const record = principals.find((principal) => principal.id === id);
      if (!record || record.revokedAt) return null;
      const expected = Buffer.from(record.secretHash, "hex");
      const actual = Buffer.from(hashSecret(secret), "hex");
      if (!timingSafeEqual(expected, actual)) return null;
      // Re-apply today's limit so a principal stored under a broader one cannot exceed it.
      return {
        principalId: servicePrincipalSessionId(record.id),
        permissions: record.permissions.filter((p) => GRANTABLE_SERVICE_PERMISSIONS.includes(p)),
        grants: record.grants,
      };
    });
  }

  private serialize<T>(operation: (principals: StoredPrincipal[]) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => operation(await this.load()));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<StoredPrincipal[]> {
    if (this.principals) return this.principals;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.principals = [];
      return this.principals;
    }
    const parsed = StoreFileSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      // Fail closed: an unreadable store admits nobody. Keep the file for diagnosis.
      await rename(this.filePath, `${this.filePath}.invalid-${Date.now()}`);
    }
    this.principals = parsed.success ? parsed.data.principals : [];
    return this.principals;
  }

  private async persist(principals: StoredPrincipal[]): Promise<void> {
    await writePrivateFileAtomic(
      this.filePath,
      `${JSON.stringify({ version: 1, principals }, null, 2)}\n`,
    );
    this.principals = principals;
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function toPublic(record: StoredPrincipal): ServicePrincipal {
  return {
    id: record.id,
    label: record.label,
    permissions: [...record.permissions],
    grants: record.grants.map((grant) => ({ ...grant })),
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
