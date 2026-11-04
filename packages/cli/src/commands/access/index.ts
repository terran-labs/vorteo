import { Command } from "commander";
import type { ServicePrincipal } from "@getpaseo/protocol/messages";
import { DAEMON_PERMISSIONS, type DaemonPermission } from "@getpaseo/protocol/messages";
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
}

interface PrincipalRow {
  id: string;
  label: string;
  permissions: string;
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
      .option("--read-only", `Grant ${READ_ONLY_SERVICE_PERMISSIONS.join(" and ")}`),
  ).action(
    withOutput(async (...args): Promise<SingleResult<PrincipalRow>> => {
      const options = args.at(-2) as CreateOptions;
      const permissions = parsePermissions([
        ...(options.readOnly ? READ_ONLY_SERVICE_PERMISSIONS : []),
        ...options.permission,
      ]);
      if (permissions.length === 0) {
        throw { code: "PERMISSION_REQUIRED", message: "Pass --read-only or --permission." };
      }
      return withDaemon(options.daemonTarget, async (client) => {
        const response = await client.createServicePrincipal({ label: options.label, permissions });
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
