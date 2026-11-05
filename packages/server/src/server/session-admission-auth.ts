import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { SessionAdmission } from "./websocket-server.js";
import type { ServicePrincipalStore } from "./authorization/service-principals.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

type AdmissionResolution = { admission: SessionAdmission } | { rejection: AdmissionFailure };

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  servicePrincipals?: Pick<ServicePrincipalStore, "authenticate"> | null;
}): Promise<AdmissionResolution> {
  const { credential, passwordHash, localCredential } = input;
  // A service credential admits only its principal, even on a daemon without a
  // password, so a scoped client never silently runs as owner.
  if (credential?.kind === "serviceCredential") {
    const admission = (await input.servicePrincipals?.authenticate(credential.token)) ?? null;
    return admission
      ? {
          admission: {
            principalId: admission.principalId,
            permissions: admission.permissions,
            agentGrants: admission.grants,
            principalLabel: admission.label,
            expiresAt: admission.expiresAt,
          },
        }
      : { rejection: "incorrect_password" };
  }
  if (!passwordHash) {
    return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
  }
  if (!credential) {
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
    }
    return { rejection: "incorrect_password" };
  }
  return (await compare(credential.password, passwordHash))
    ? { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } }
    : { rejection: "incorrect_password" };
}
