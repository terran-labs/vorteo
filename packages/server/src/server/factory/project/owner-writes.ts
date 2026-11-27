import { factoryProjectConfigure, factoryProjectEnable } from "@getpaseo/server/factory-project";

/** The `rpc_error` code, and log code, of a refused owner-only Factory write. */
export const FACTORY_OWNER_ONLY_CODE = "factory_owner_only";

/**
 * `factory.project.configure` fields that decide what Factory launches: a role's own launch
 * (`provider`, `profileId`, which sets the Foreman's preset among others), the three stage presets
 * and where issue agents run. The Factory stage rule (#360, slice C1b) compares launches against
 * these, so they are written only by the owner. `planning` and `role` alone are not here: `role`
 * only names whose launch the other fields set, and planning changes no preset or placement.
 */
const OWNER_ONLY_CONFIGURE_FIELDS = [
  "provider",
  "profileId",
  "plannerProfileId",
  "workerProfileId",
  "reviewerProfileId",
  "issueAgents",
] as const;

/**
 * The owner-only fields a Factory RPC would write, or an empty list when it writes none.
 *
 * - `factory.project.enable` with `adopt` names which thread holds a role. The role record is the
 *   trust anchor for the Factory stage rule, so only the owner may point it at a thread. Enable
 *   without `adopt` stays open: it creates role threads itself and records them.
 * - `factory.project.configure`, for the fields above.
 *
 * Every other method, including `factory.project.status.set` (a role's one-line status, which the
 * Foreman and Builds set through the CLI), writes nothing here and is unaffected.
 *
 * The caller checks this against the session's client type before invoking the service. That
 * check is `isOwnerAppClient`, the same gate as the preset fence setting (#589), and it has the
 * same limit (#525): the client type is self-declared in the hello. It stops agent tools, the
 * CLI and accidents, not a process holding the daemon credential that claims to be the app.
 */
export function factoryOwnerOnlyFields(method: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const fields = input as Record<string, unknown>;
  if (method === factoryProjectEnable.name) return fields.adopt !== undefined ? ["adopt"] : [];
  if (method === factoryProjectConfigure.name)
    return OWNER_ONLY_CONFIGURE_FIELDS.filter((field) => fields[field] !== undefined);
  return [];
}

/**
 * A Factory refusal the owner's app can act on: the session answers it as an `rpc_error` with
 * this code (the optional `code` field already carries free-form codes, so older clients only see
 * the message), logged once at warn rather than as a failure.
 */
export class FactoryRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FactoryRefusal";
  }
}

/** Enable found a live thread wearing the Foreman's label while no Foreman is recorded. */
export const FACTORY_FOREMAN_UNADOPTED_CODE = "factory_foreman_unadopted";

/** Claim refused: no trusted account approved the issue's current text. */
export const FACTORY_ISSUE_UNTRUSTED_CODE = "factory_issue_untrusted";

/** Claim refused: the issue's pull request changes a file only the owner may change. */
export const FACTORY_OWNER_ONLY_FILE_CODE = "factory_owner_only_file";
