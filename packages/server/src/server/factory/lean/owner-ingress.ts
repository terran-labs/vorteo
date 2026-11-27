import type { Stats } from "node:fs";
import { lstat, mkdir, chmod } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import {
  factoryLeanAnswer,
  factoryLeanIntentSet,
  factoryLeanRulesAdd,
  factoryLeanRulesList,
  factoryLeanRulesRemove,
} from "@getpaseo/server/factory-project";
import { z } from "zod";
import { OwnerSessions } from "../../execution-installation/owner-sessions.js";
import { FactoryRefusal } from "../project/owner-writes.js";
import type { LeanHandlers } from "./handlers.js";

const endpoint = "/lean-owner-action";
const requestLimit = 64 * 1024;
const responseLimit = 256 * 1024;
const timeoutMs = 15_000;
const ownerToken = /^[A-Za-z0-9_-]{43}$/u;

const ownerContracts = [
  factoryLeanAnswer,
  factoryLeanIntentSet,
  factoryLeanRulesAdd,
  factoryLeanRulesList,
  factoryLeanRulesRemove,
] as const;

const envelope = z.strictObject({ method: z.string(), input: z.unknown() });
const forwardedEnvelope = z.strictObject({
  installationId: z.string().uuid(),
  serverId: z.string().min(1),
  localOrigin: z.string().optional(),
  action: envelope,
});

interface HostOwnerScope {
  installationId: string;
  serverId: string;
}

interface OwnerSessionVerifier {
  expiresAt(token: string, origin?: string): string | null | Promise<string | null>;
}

interface OwnerResponse {
  status: number;
  body: { output: unknown } | { error: string };
}

function failure(status: number, error: string): OwnerResponse {
  return { status, body: { error } };
}

function parseAction(raw: unknown) {
  const action = envelope.parse(raw);
  const contract = ownerContracts.find(({ name }) => name === action.method);
  if (!contract) throw new Error("This method is outside the Lean Factory owner bridge.");
  return { method: action.method, input: contract.input.parse(action.input), contract };
}

export function leanOwnerSocketPath(hostHome: string): string {
  if (!isAbsolute(hostHome)) throw new Error("The managed Host home must be absolute.");
  return join(hostHome, "factory-owner", "rpc.sock");
}

function isOwnerPrivate(stat: Stats): boolean {
  return process.getuid !== undefined && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

/** Uses the existing hashed registry, rechecking its custody and expiry on every action. */
export function createLeanOwnerSessionRegistry(file: string, now = Date.now): OwnerSessionVerifier {
  if (!isAbsolute(file))
    throw new Error("The owner session registry must be an absolute managed path.");
  const registry = new OwnerSessions(file, now);
  return {
    async expiresAt(token, origin) {
      const [directory, sessionFile] = await Promise.all([lstat(dirname(file)), lstat(file)]);
      if (
        !directory.isDirectory() ||
        !sessionFile.isFile() ||
        !isOwnerPrivate(directory) ||
        !isOwnerPrivate(sessionFile) ||
        sessionFile.nlink !== 1
      ) {
        throw new Error("The installation owner session registry is not private.");
      }
      return registry.expiresAt(token, origin);
    },
  };
}

/** Bound by the Host bootstrap to the installation's private retained OwnerSessions registry. */
export function createLeanOwnerIngress(
  options: HostOwnerScope & {
    sessions: OwnerSessionVerifier;
    localOrigins: ReadonlySet<string>;
    handlers: Pick<LeanHandlers, "invokeOwner">;
  },
) {
  return async function invoke(
    authorization: string | undefined,
    raw: unknown,
  ): Promise<OwnerResponse> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token || !ownerToken.test(token) || token.length !== 43) {
      return failure(401, "A verified installation owner session is required.");
    }
    const parsed = forwardedEnvelope.safeParse(raw);
    if (!parsed.success) return failure(400, "Invalid Lean Factory owner request.");
    const { installationId, serverId, localOrigin, action } = parsed.data;
    if (
      installationId !== options.installationId ||
      serverId !== options.serverId ||
      (localOrigin !== undefined && !options.localOrigins.has(localOrigin))
    ) {
      return failure(403, "This owner request does not belong to the managed Host.");
    }
    try {
      if (!(await options.sessions.expiresAt(token, localOrigin))) {
        return failure(401, "The installation owner session expired or was revoked.");
      }
    } catch {
      return failure(503, "Installation owner session verification is unavailable.");
    }
    let verified: ReturnType<typeof parseAction>;
    try {
      verified = parseAction(action);
    } catch {
      return failure(400, "Invalid Lean Factory owner action.");
    }

    try {
      const output = await options.handlers.invokeOwner(verified.method, verified.input);
      return { status: 200, body: { output: verified.contract.output.parse(output) } };
    } catch (error) {
      if (error instanceof FactoryRefusal) return failure(409, error.message);
      return failure(503, "Lean Factory owner actions are unavailable in that project.");
    }
  };
}

type OwnerIngress = ReturnType<typeof createLeanOwnerIngress>;

async function readJson(message: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of message) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new Error("The Lean owner request exceeds its size limit.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function assertPrivatePath(path: string, kind: "directory" | "socket"): Promise<void> {
  const stat = await lstat(path);
  const correctKind = kind === "directory" ? stat.isDirectory() : stat.isSocket();
  if (!correctKind || !isOwnerPrivate(stat)) {
    throw new Error("The Lean Factory owner transport is not private.");
  }
}

/** Only the installed native Host may call this with a verified local session registry. */
export async function listenLeanOwnerIngress(path: string, invoke: OwnerIngress): Promise<Server> {
  if (!isAbsolute(path)) throw new Error("The Lean Factory owner socket path must be absolute.");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivatePath(directory, "directory");
  const server = createServer((req, res) => {
    void (async () => {
      let result = failure(404, "Unknown Lean Factory owner route.");
      if (req.method === "POST" && req.url === endpoint) {
        const raw = await readJson(req, requestLimit).catch(() => null);
        result = await invoke(req.headers.authorization, raw);
      }
      res.writeHead(result.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result.body));
    })().catch(() => {
      res.destroy();
    });
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o600);
    await assertPrivatePath(path, "socket");
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

/** Call only after the coordinator has checked the request Origin and current owner cookie. */
export async function forwardLeanOwnerAction(
  options: HostOwnerScope & {
    socketPath: string;
    ownerSession: string;
    localOrigin?: string;
    action: unknown;
  },
): Promise<OwnerResponse> {
  if (!ownerToken.test(options.ownerSession) || options.ownerSession.length !== 43) {
    return failure(401, "A verified installation owner session is required.");
  }
  let action: ReturnType<typeof parseAction>;
  try {
    action = parseAction(options.action);
  } catch {
    return failure(400, "Invalid Lean Factory owner action.");
  }
  const body = JSON.stringify({
    installationId: options.installationId,
    serverId: options.serverId,
    localOrigin: options.localOrigin,
    action: { method: action.method, input: action.input },
  });
  if (Buffer.byteLength(body) > requestLimit)
    return failure(413, "The Lean Factory owner action is too large.");

  try {
    if (!isAbsolute(options.socketPath)) throw new Error("Expected a private Host socket.");
    await assertPrivatePath(dirname(options.socketPath), "directory");
    await assertPrivatePath(options.socketPath, "socket");
    return await new Promise<OwnerResponse>((resolve, reject) => {
      const client = request(
        {
          socketPath: options.socketPath,
          agent: false,
          path: endpoint,
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.ownerSession}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            const status = response.statusCode;
            resolve(
              status === 400 || status === 401 || status === 403 || status === 409
                ? failure(status, "The managed Host refused the Lean Factory owner action.")
                : failure(503, "The managed Host cannot verify Lean Factory owner actions."),
            );
            return;
          }
          void readJson(response, responseLimit)
            .then((raw) => {
              const { output } = z.strictObject({ output: action.contract.output }).parse(raw);
              return { status: 200, body: { output } };
            })
            .then(resolve, reject);
        },
      );
      client.once("error", reject);
      client.once("timeout", () =>
        client.destroy(new Error("Lean Factory owner request timed out.")),
      );
      client.end(body);
    });
  } catch {
    return failure(503, "The managed Host cannot verify Lean Factory owner actions.");
  }
}
