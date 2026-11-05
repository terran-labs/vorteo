import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { DAEMON_PERMISSIONS, type DaemonPermission } from "@getpaseo/protocol/messages";
import {
  type PermissionRequirement,
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

export { DAEMON_PERMISSIONS, type DaemonPermission };

const daemonPermissionSet: ReadonlySet<string> = new Set(DAEMON_PERMISSIONS);

export function isDaemonPermission(value: string): value is DaemonPermission {
  return daemonPermissionSet.has(value);
}

export function parseDaemonPermissions(values: readonly string[]): DaemonPermission[] {
  const permissions = [...new Set(values)];
  if (!permissions.every(isDaemonPermission)) throw new Error("Invalid daemon permission");
  return permissions;
}

export const OWNER_PERMISSIONS: readonly DaemonPermission[] = DAEMON_PERMISSIONS;

export interface SessionRestrictions {
  /** When set, the only inbound operation types the session may send. */
  allowedInbound?: ReadonlySet<string>;
  /** Inbound operation types denied even when the permission allows them. */
  deniedInbound: ReadonlySet<string>;
}

export class SessionAuthorization {
  private permissions: ReadonlySet<DaemonPermission>;
  private readonly restrictions: SessionRestrictions | null;
  private outboundExtension: ((message: SessionOutboundMessage) => boolean) | null = null;

  constructor(permissions: readonly DaemonPermission[], restrictions?: SessionRestrictions) {
    this.permissions = new Set(permissions);
    this.restrictions = restrictions ?? null;
  }

  allowsInbound(message: SessionInboundMessage): boolean {
    if (this.restrictsOperation(message.type)) return false;
    return this.allows(requiredPermissionForInbound(message.type));
  }

  allowsOutbound(message: SessionOutboundMessage): boolean {
    return (
      this.allows(requiredPermissionForOutbound(message)) ||
      this.outboundExtension?.(message) === true
    );
  }

  /** True when restrictions refuse an operation type regardless of permissions or grants. */
  restrictsOperation(type: string): boolean {
    if (!this.restrictions) return false;
    if (this.restrictions.allowedInbound && !this.restrictions.allowedInbound.has(type))
      return true;
    return this.restrictions.deniedInbound.has(type);
  }

  /** Additional resource-scoped delivery, such as agent grants, beyond daemon-wide permissions. */
  setOutboundExtension(extension: ((message: SessionOutboundMessage) => boolean) | null): void {
    this.outboundExtension = extension;
  }

  replacePermissions(permissions: readonly DaemonPermission[]): void {
    this.permissions = new Set(permissions);
  }

  listPermissions(): DaemonPermission[] {
    return [...this.permissions];
  }

  allowsPermission(permission: DaemonPermission): boolean {
    return this.permissions.has(permission);
  }

  private allows(requirement: PermissionRequirement): boolean {
    if (requirement === null) return true;
    if (typeof requirement === "string") return this.permissions.has(requirement);
    return requirement.some((permission) => this.permissions.has(permission));
  }
}

const LEGACY_HUB_EXECUTION_SCOPE = "hub.execution.*";

export function permissionsForLegacyHubScopes(
  scopes: readonly string[],
): readonly DaemonPermission[] {
  // COMPAT(semanticHubPermissions): added in v0.7, remove after Hub enrollment uses permissions.
  return scopes.includes(LEGACY_HUB_EXECUTION_SCOPE) ? ["hub.execute"] : [];
}
