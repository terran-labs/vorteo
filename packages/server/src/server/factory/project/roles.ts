import type { WorkspaceFactoryMembershipSchema } from "@getpaseo/protocol/messages";
import type { z } from "zod";
import {
  PROJECT_FACTORY_ROLE_IDS,
  type ProjectFactoryRoleId,
} from "@getpaseo/server/factory-project";

import { BUILDS_FIRST_PROMPT, BUILDS_TICK_PROMPT, buildsCharter } from "./charters/builds.js";
import { FOREMAN_FIRST_PROMPT, FOREMAN_TICK_PROMPT, foremanCharter } from "./charters/foreman.js";
import {
  MECHANIC_FIRST_PROMPT,
  MECHANIC_TICK_PROMPT,
  mechanicCharter,
} from "./charters/mechanic.js";
import {
  RELEASES_FIRST_PROMPT,
  RELEASES_TICK_PROMPT,
  releasesCharter,
} from "./charters/releases.js";
import type { CharterInput } from "./charters/shared.js";
import { TRIAGE_FIRST_PROMPT, TRIAGE_TICK_PROMPT, triageCharter } from "./charters/triage.js";

type WireMembershipRole = z.infer<typeof WorkspaceFactoryMembershipSchema>["role"];

export interface ProjectFactoryRole {
  id: ProjectFactoryRoleId;
  title: string;
  cron: string;
  /**
   * The wire membership enum is `factory | builds | worker` and must not widen, so every
   * coordinator role except Builds travels as `factory`. The state file keeps the real role.
   */
  membershipRole: WireMembershipRole;
  charter: (input: CharterInput) => string;
  firstPrompt: string;
  tickPrompt: string;
}

/** The standing roles, in sidebar folder order. */
export const PROJECT_FACTORY_ROLES: readonly ProjectFactoryRole[] = [
  {
    id: "factory-triage",
    title: "Triage",
    cron: "0 8 * * *",
    membershipRole: "factory",
    charter: triageCharter,
    firstPrompt: TRIAGE_FIRST_PROMPT,
    tickPrompt: TRIAGE_TICK_PROMPT,
  },
  {
    id: "factory-intake",
    title: "Foreman",
    cron: "*/10 * * * *",
    membershipRole: "factory",
    charter: foremanCharter,
    firstPrompt: FOREMAN_FIRST_PROMPT,
    tickPrompt: FOREMAN_TICK_PROMPT,
  },
  {
    id: "factory-builds",
    title: "Builds",
    cron: "*/15 * * * *",
    membershipRole: "builds",
    charter: buildsCharter,
    firstPrompt: BUILDS_FIRST_PROMPT,
    tickPrompt: BUILDS_TICK_PROMPT,
  },
  {
    id: "factory-releases",
    title: "Releases",
    cron: "0 9 * * *",
    membershipRole: "factory",
    charter: releasesCharter,
    firstPrompt: RELEASES_FIRST_PROMPT,
    tickPrompt: RELEASES_TICK_PROMPT,
  },
  {
    id: "factory-mechanic",
    title: "Mechanic",
    cron: "0 * * * *",
    membershipRole: "factory",
    charter: mechanicCharter,
    firstPrompt: MECHANIC_FIRST_PROMPT,
    tickPrompt: MECHANIC_TICK_PROMPT,
  },
];

// The shared schema and this table must name the same roles in the same order.
if (PROJECT_FACTORY_ROLES.map((role) => role.id).join() !== PROJECT_FACTORY_ROLE_IDS.join())
  throw new Error("Project Factory role table does not match the shared role IDs.");

export function projectFactoryRole(id: ProjectFactoryRoleId): ProjectFactoryRole {
  const role = PROJECT_FACTORY_ROLES.find((candidate) => candidate.id === id);
  if (!role) throw new Error(`Unknown Factory role: ${id}`);
  return role;
}

/** Marks an agent bound to a role, so a lost state file never leads to a second one. */
export const PROJECT_FACTORY_ROLE_LABEL = "vorteo.factory-role";

export function roleLabelValue(projectId: string, role: ProjectFactoryRoleId): string {
  return `${projectId}:${role}`;
}

/** The installation identity every project Factory member carries on the wire. */
export function projectFactoryInstallationId(projectId: string): string {
  return `project-factory:${projectId}`;
}
