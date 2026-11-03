import { z } from "zod";
import { normalizeSidebarFolders, validateSidebarFolderPatch } from "./sidebar-folders.js";

const KeysSchema = z.array(z.string().min(1).max(8192)).max(10000);
const FlagsSchema = z.record(z.string(), z.boolean());
const FolderIdSchema = z.string().min(1).max(200);
const ItemKeySchema = z.string().min(1).max(8192);

export const SidebarFolderScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("project"), projectKey: ItemKeySchema }),
]);
export type SidebarFolderScope = z.infer<typeof SidebarFolderScopeSchema>;

/** Folders only organize the sidebar. They never correspond to anything on disk. */
export const SidebarFolderSchema = z.object({
  id: FolderIdSchema,
  name: z.string().min(1).max(200),
  parentId: FolderIdSchema.nullable(),
  scope: SidebarFolderScopeSchema,
  createdAt: z.string(),
});
export type SidebarFolder = z.infer<typeof SidebarFolderSchema>;

export const SidebarStateSchema = z.object({
  projectOrder: KeysSchema,
  pinnedWorkspaceOrder: KeysSchema,
  workspaceOrderByProject: z.record(z.string(), KeysSchema),
  collapsedProjects: FlagsSchema,
  collapsedWorkspaceGroups: FlagsSchema,
  collapsedPinned: z.boolean(),
  groupMode: z.enum(["project", "status"]),
  hostFilters: KeysSchema,
  projectFilters: KeysSchema,
  labelFilters: z.array(z.string()),
  // Folder fields are absent until a client that sees `features.sidebarFolders` writes them.
  sidebarFolders: z.record(FolderIdSchema, SidebarFolderSchema).optional(),
  /** Project view keys map to root folders; `serverId:workspaceId` keys to project folders. */
  itemFolder: z.record(ItemKeySchema, FolderIdSchema).optional(),
  /** Keys are `root`, `folder:<id>` or `project:<viewKey>`; entries are item keys or `folder:<id>`. */
  childOrder: z.record(z.string(), KeysSchema).optional(),
  collapsedFolders: z.record(FolderIdSchema, z.boolean()).optional(),
});
export type SidebarState = z.infer<typeof SidebarStateSchema>;
/**
 * Keys to put at the top of a saved order when that order does not already contain them. Clients
 * send this when a project, workspace or folder appears, so the Host records the first-row
 * placement against its own current order instead of a device's possibly stale copy.
 */
export const SidebarPlaceFirstSchema = z.object({
  projectOrder: KeysSchema.optional(),
  workspaceOrderByProject: z.record(z.string(), KeysSchema).optional(),
  childOrder: z.record(z.string(), KeysSchema).optional(),
});
export type SidebarPlaceFirst = z.infer<typeof SidebarPlaceFirstSchema>;
/** In folder records a `null` value removes that key; other records merge by key. */
export const SidebarStatePatchSchema = SidebarStateSchema.partial().extend({
  sidebarFolders: z.record(FolderIdSchema, SidebarFolderSchema.nullable()).optional(),
  itemFolder: z.record(ItemKeySchema, FolderIdSchema.nullable()).optional(),
  childOrder: z.record(z.string(), KeysSchema.nullable()).optional(),
  collapsedFolders: z.record(FolderIdSchema, z.boolean().nullable()).optional(),
  // COMPAT(sidebarPlacement): added 2026-11-03. Older Hosts strip this field, so send it only
  // when `features.sidebarPlacement` is advertised.
  placeFirst: SidebarPlaceFirstSchema.optional(),
});
export type SidebarStatePatch = z.infer<typeof SidebarStatePatchSchema>;
export const SidebarStateChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialize"), state: SidebarStatePatchSchema }),
  z.object({ type: z.literal("patch"), patch: SidebarStatePatchSchema }),
]);
export type SidebarStateChange = z.infer<typeof SidebarStateChangeSchema>;
export const SidebarStateSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  state: SidebarStateSchema.nullable(),
});
export type SidebarStateSnapshot = z.infer<typeof SidebarStateSnapshotSchema>;

export function emptySidebarState(): SidebarState {
  return {
    projectOrder: [],
    pinnedWorkspaceOrder: [],
    workspaceOrderByProject: {},
    collapsedProjects: {},
    collapsedWorkspaceGroups: {},
    collapsedPinned: false,
    groupMode: "project",
    hostFilters: [],
    projectFilters: [],
    labelFilters: [],
  };
}

/** Patches address individual projects so unrelated device edits survive. */
export function mergeSidebarStatePatch(
  left: SidebarStatePatch,
  right: SidebarStatePatch,
): SidebarStatePatch {
  const result = { ...left, ...right };
  if (right.workspaceOrderByProject)
    result.workspaceOrderByProject = {
      ...left.workspaceOrderByProject,
      ...right.workspaceOrderByProject,
    };
  if (right.collapsedProjects)
    result.collapsedProjects = { ...left.collapsedProjects, ...right.collapsedProjects };
  if (right.collapsedWorkspaceGroups)
    result.collapsedWorkspaceGroups = {
      ...left.collapsedWorkspaceGroups,
      ...right.collapsedWorkspaceGroups,
    };
  if (right.sidebarFolders)
    result.sidebarFolders = { ...left.sidebarFolders, ...right.sidebarFolders };
  if (right.itemFolder) result.itemFolder = { ...left.itemFolder, ...right.itemFolder };
  if (right.childOrder) result.childOrder = { ...left.childOrder, ...right.childOrder };
  if (right.collapsedFolders)
    result.collapsedFolders = { ...left.collapsedFolders, ...right.collapsedFolders };
  const earlierPlacement = left.placeFirst && withoutReplacedLists(left.placeFirst, right);
  if (right.placeFirst) result.placeFirst = mergePlaceFirst(earlierPlacement, right.placeFirst);
  else if (earlierPlacement) result.placeFirst = earlierPlacement;
  else delete result.placeFirst;
  return result;
}

/**
 * A later whole-list replacement already decided where every key goes, so earlier placements
 * for that list must not run after it and restore keys it removed.
 */
function withoutReplacedLists(
  placement: SidebarPlaceFirst,
  later: SidebarStatePatch,
): SidebarPlaceFirst | undefined {
  const result: SidebarPlaceFirst = { ...placement };
  if (later.projectOrder) delete result.projectOrder;
  result.workspaceOrderByProject = withoutKeys(
    placement.workspaceOrderByProject,
    later.workspaceOrderByProject,
  );
  result.childOrder = withoutKeys(placement.childOrder, later.childOrder);
  for (const key of ["workspaceOrderByProject", "childOrder"] as const)
    if (!result[key]) delete result[key];
  return Object.keys(result).length > 0 ? result : undefined;
}

function withoutKeys(
  record: Record<string, string[]> | undefined,
  replaced: Record<string, unknown> | undefined,
): Record<string, string[]> | undefined {
  if (!record) return undefined;
  const kept = Object.fromEntries(Object.entries(record).filter(([key]) => !replaced?.[key]));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Later keys go first, matching what applying the two patches in sequence would produce. */
function prependKeys(later: readonly string[], earlier: readonly string[] = []): string[] {
  return [...new Set([...later, ...earlier])];
}

function mergeKeyRecords(
  left: Record<string, string[]> | undefined,
  right: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!right) return left;
  const result = { ...left };
  for (const [key, keys] of Object.entries(right)) result[key] = prependKeys(keys, left?.[key]);
  return result;
}

function mergePlaceFirst(
  left: SidebarPlaceFirst | undefined,
  right: SidebarPlaceFirst,
): SidebarPlaceFirst {
  const result: SidebarPlaceFirst = { ...left };
  if (right.projectOrder) result.projectOrder = prependKeys(right.projectOrder, left?.projectOrder);
  const workspaceOrderByProject = mergeKeyRecords(
    left?.workspaceOrderByProject,
    right.workspaceOrderByProject,
  );
  if (workspaceOrderByProject) result.workspaceOrderByProject = workspaceOrderByProject;
  const childOrder = mergeKeyRecords(left?.childOrder, right.childOrder);
  if (childOrder) result.childOrder = childOrder;
  return result;
}

/** Puts each missing key first, in the given order. Keys already in the list keep their place. */
export function placeKeysFirst(order: readonly string[], keys: readonly string[]): string[] {
  const present = new Set(order);
  const missing = [...new Set(keys)].filter((key) => !present.has(key));
  return missing.length === 0 ? [...order] : [...missing, ...order];
}

/** Runs on the merged patch, where a `null` folder entry still marks a removed container. */
function applyPlaceFirst(
  state: SidebarStatePatch,
  placeFirst: SidebarPlaceFirst,
): SidebarStatePatch {
  const next: SidebarStatePatch = { ...state };
  if (placeFirst.projectOrder)
    next.projectOrder = placeKeysFirst(state.projectOrder ?? [], placeFirst.projectOrder);
  if (placeFirst.workspaceOrderByProject) {
    next.workspaceOrderByProject = { ...state.workspaceOrderByProject };
    for (const [projectKey, keys] of Object.entries(placeFirst.workspaceOrderByProject))
      next.workspaceOrderByProject[projectKey] = placeKeysFirst(
        state.workspaceOrderByProject?.[projectKey] ?? [],
        keys,
      );
  }
  if (placeFirst.childOrder) {
    // Only containers that already have a saved order need the key: an unsaved container
    // follows the flat order, which already lists the item first.
    const childOrder = { ...state.childOrder };
    for (const [container, keys] of Object.entries(placeFirst.childOrder)) {
      const saved = childOrder[container];
      if (saved) childOrder[container] = placeKeysFirst(saved, keys);
    }
    next.childOrder = childOrder;
  }
  return next;
}

function withoutRemovedKeys<T>(
  record: Record<string, T | null> | undefined,
): Record<string, T> | undefined {
  if (!record) return undefined;
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) if (value !== null) kept[key] = value;
  return kept;
}

/**
 * Applies a patch and then repairs the folder tree, so every device and the Host reach the same
 * structure even when concurrent edits conflict. Removing a folder moves its contents to its parent.
 */
export function applySidebarStatePatch(
  state: SidebarState,
  patch: SidebarStatePatch,
): SidebarState {
  validateSidebarFolderPatch(patch);
  const { placeFirst, ...replacements } = patch;
  const replaced = mergeSidebarStatePatch(state, replacements);
  // Placement runs after replacements, so a drag in the same patch keeps the keys it positioned.
  const merged = placeFirst ? applyPlaceFirst(replaced, placeFirst) : replaced;
  const next = SidebarStateSchema.parse({
    ...merged,
    sidebarFolders: withoutRemovedKeys(merged.sidebarFolders),
    itemFolder: withoutRemovedKeys(merged.itemFolder),
    childOrder: withoutRemovedKeys(merged.childOrder),
    collapsedFolders: withoutRemovedKeys(merged.collapsedFolders),
  });
  return normalizeSidebarFolders({ previous: state, patch, next });
}
