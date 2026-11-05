import { Command } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AgentGrant, ServicePrincipal } from "@getpaseo/protocol/messages";
import {
  AgentGrantSchema,
  DAEMON_PERMISSIONS,
  type DaemonPermission,
} from "@getpaseo/protocol/messages";
import {
  withOutput,
  type ListResult,
  type OutputSchema,
  type SingleResult,
} from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

interface AccessOptions {
  daemonTarget: DaemonTarget;
  json?: boolean;
}

interface CreateOptions extends AccessOptions {
  label: string;
  permission: string[];
  readOnly?: boolean;
  grantsFile?: string;
  expiresAt?: string;
}

interface SetGrantsOptions extends AccessOptions {
  grantsFile: string;
}

interface PrincipalRow {
  id: string;
  label: string;
  permissions: string;
  grants: string;
  status: string;
  createdAt: string;
  token?: string;
}

/** Read-only preset: observe projects, workspaces and agents. */
export const READ_ONLY_SERVICE_PERMISSIONS: DaemonPermission[] = ["workspace.read"];

const schema: OutputSchema<PrincipalRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "LABEL", field: "label" },
    { header: "PERMISSIONS", field: "permissions" },
    { header: "GRANTS", field: "grants" },
    { header: "STATUS", field: "status" },
    { header: "CREATED", field: "createdAt" },
  ],
};

const createdSchema: OutputSchema<PrincipalRow> = {
  ...schema,
  renderHuman: (result) => {
    const row = result.data as PrincipalRow;
    return [
      `Created service principal ${row.id} (${row.label}) with ${row.permissions}.`,
      "Token (shown once; store it in a 0600 file):",
      row.token ?? "",
    ].join("\n");
  },
};

function toRow(principal: ServicePrincipal): PrincipalRow {
  return {
    id: principal.id,
    label: principal.label,
    permissions: principal.permissions.join(","),
    grants: (principal.grants ?? [])
      .map(
        (grant) =>
          `${grant.actions.join("+")} on ${[
            ...(grant.agentIds ?? []).map((id) => `agent:${id}`),
            ...(grant.workspaceIds ?? []).map((id) => `workspace:${id}`),
          ].join(",")}`,
      )
      .join("; "),
    status: principal.revokedAt ? `revoked ${principal.revokedAt}` : "active",
    createdAt: principal.createdAt,
  };
}

function parsePermissions(values: readonly string[]): DaemonPermission[] {
  const known: readonly string[] = DAEMON_PERMISSIONS;
  const unknown = values.filter((value) => !known.includes(value));
  if (unknown.length > 0) {
    throw {
      code: "INVALID_PERMISSION",
      message: `Unknown permission ${unknown.join(", ")}. Known: ${DAEMON_PERMISSIONS.join(", ")}`,
    };
  }
  return [...new Set(values)] as DaemonPermission[];
}

/** Reads a JSON array of agent grants, e.g. [{"actions":["agent.read"],"agentIds":["..."]}]. */
function readGrants(path: string): AgentGrant[] {
  const parsed = z.array(AgentGrantSchema).safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw { code: "INVALID_GRANTS", message: `Invalid grants file: ${parsed.error.message}` };
  return parsed.data;
}

async function withDaemon<T>(
  target: DaemonTarget,
  action: (client: Awaited<ReturnType<typeof connectToDaemon>>) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target });
  try {
    if (client.getLastServerInfoMessage()?.features?.servicePrincipals !== true) {
      throw {
        code: "UNSUPPORTED_DAEMON",
        message: "Update this daemon to manage service principals.",
      };
    }
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function failIf(error: string | null): void {
  if (error) throw { code: "SERVICE_PRINCIPAL_FAILED", message: error };
}

export function createAccessCommand(): Command {
  const access = new Command("access").description("Manage daemon access");
  const service = access
    .command("service")
    .description("Service principals: non-interactive credentials with chosen permissions");

  addJsonAndDaemonHostOptions(
    service.command("list").description("List service principals"),
  ).action(
    withOutput(async (...args): Promise<ListResult<PrincipalRow>> => {
      const options = args.at(-2) as AccessOptions;
      return withDaemon(options.daemonTarget, async (client) => {
        const response = await client.listServicePrincipals();
        failIf(response.error);
        return { type: "list", data: response.principals.map(toRow), schema };
      });
    }),
  );

  addJsonAndDaemonHostOptions(
    service
      .command("create")
      .description("Create a service principal and print its token once")
      .requiredOption("--label <label>", "Who or what uses this credential")
      .option(
        "--permission <permission>",
        "Grant a daemon permission (repeatable)",
        collectMultiple,
        [],
      )
      .option(
        "--read-only",
        `Grant daemon-wide ${READ_ONLY_SERVICE_PERMISSIONS.join(" and ")}. For the installation coordinator; give external apps an overview observer token or agent grants instead`,
      )
      .option("--expires-at <iso>", "Refuse the token after this ISO time")
      .option(
        "--grants-file <path>",
        "JSON array of agent grants. Prefer agentIds: a workspace read grant also covers full-tool agents created there later",
      ),
  ).action(
    withOutput(async (...args): Promise<SingleResult<PrincipalRow>> => {
      const options = args.at(-2) as CreateOptions;
      const permissions = parsePermissions([
        ...(options.readOnly ? READ_ONLY_SERVICE_PERMISSIONS : []),
        ...options.permission,
      ]);
      const grants = options.grantsFile ? readGrants(options.grantsFile) : [];
      if (permissions.length === 0 && grants.length === 0) {
        throw {
          code: "PERMISSION_REQUIRED",
          message: "Pass --read-only, --permission or --grants-file.",
        };
      }
      return withDaemon(options.daemonTarget, async (client) => {
        const response = await client.createServicePrincipal({
          label: options.label,
          permissions,
          grants,
          ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        });
        failIf(response.error);
        return {
          type: "single",
          data: { ...toRow(response.principal!), token: response.token! },
          schema: createdSchema,
        };
      });
    }),
  );

  addJsonAndDaemonHostOptions(
    service
      .command("set-grants")
      .description("Replace a service principal's agent grants and reconnect its sessions")
      .argument("<id>", "Service principal ID")
      .requiredOption("--grants-file <path>", "JSON array of agent grants; [] removes all"),
  ).action(
    withOutput(async (...args): Promise<SingleResult<PrincipalRow>> => {
      const id = args[0] as string;
      const options = args.at(-2) as SetGrantsOptions;
      const grants = readGrants(options.grantsFile);
      return withDaemon(options.daemonTarget, async (client) => {
        const response = await client.setServicePrincipalGrants(id, grants);
        failIf(response.error);
        return { type: "single", data: toRow(response.principal!), schema };
      });
    }),
  );

  addJsonAndDaemonHostOptions(
    service
      .command("revoke")
      .description("Revoke a service principal and disconnect its sessions")
      .argument("<id>", "Service principal ID"),
  ).action(
    withOutput(async (...args): Promise<SingleResult<PrincipalRow>> => {
      const id = args[0] as string;
      const options = args.at(-2) as AccessOptions;
      return withDaemon(options.daemonTarget, async (client) => {
        const response = await client.revokeServicePrincipal(id);
        failIf(response.error);
        return { type: "single", data: toRow(response.principal!), schema };
      });
    }),
  );

  return access;
}
