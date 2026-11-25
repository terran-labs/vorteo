import { createHash } from "node:crypto";
import { z } from "zod";

/** The claims of an unverified JWT. Only used for scheduling, display and same-person checks. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const PersonClaimsSchema = z.object({
  sub: z.string().min(1).optional(),
  "https://api.openai.com/auth": z
    .object({ chatgpt_user_id: z.string().min(1).optional() })
    .optional(),
});

/**
 * The person a Codex ID token names. Codex's `tokens.account_id` is the ChatGPT workspace
 * (`chatgpt_account_id`), which every member of a Team or Business workspace shares, so it alone
 * cannot tell two people apart. `chatgpt_user_id` is preferred; `sub` is the fallback. The kind
 * is part of the key, so a token naming the person one way never matches one naming them the
 * other way: that refuses, which is the safe direction. Never log the result.
 */
export function codexIdTokenPerson(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const claims = PersonClaimsSchema.safeParse(jwtClaims(idToken));
  if (!claims.success) return null;
  const user = claims.data["https://api.openai.com/auth"]?.chatgpt_user_id;
  if (user) return `chatgpt_user_id:${user}`;
  return claims.data.sub ? `sub:${claims.data.sub}` : null;
}

/**
 * A one-way digest of the ChatGPT workspace and person a sign-in names, so a record can tell
 * later whether the Host is still signed in as the same person without keeping either ID.
 * Null when either is missing.
 */
export function codexSignInKeyDigest(
  accountId: string | null,
  idToken: string | null | undefined,
): string | null {
  const person = codexIdTokenPerson(idToken);
  if (!accountId || !person) return null;
  return createHash("sha256").update(`${accountId}\n${person}`).digest("hex");
}

/**
 * Whether a sign-in found in a Codex home belongs to the same person in the same workspace as
 * the Host's sign-in. Both sides must name a workspace and a person; anything missing refuses.
 */
export function sameCodexSignIn(
  local: { accountId: string | null; idToken: string | null },
  host: { accountId: string | null; idToken: string },
): boolean {
  if (!local.accountId || !host.accountId || local.accountId !== host.accountId) return false;
  const person = codexIdTokenPerson(host.idToken);
  return person !== null && codexIdTokenPerson(local.idToken) === person;
}
