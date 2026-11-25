import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CodexSessionCheck } from "./codex-signin-delivery.js";

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

const SessionClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1).optional(),
  auth_time: z.union([z.number(), z.string().min(1)]).optional(),
});

/**
 * Two keyed fingerprints of the login session an ID token belongs to, under a single-use nonce:
 * the person (`sub`) with the session ID (`sid`), and the person with the authentication time
 * (`auth_time`), each only when the token names it, all from top-level claims. A refresh is
 * assumed to keep at least one of them, so a stale copy of a grant still matches. Null when the
 * token names no person. Never store or log the nonce, the fingerprints or the claims.
 */
function sessionFingerprints(nonce: Buffer, idToken: string | null | undefined) {
  const claims = SessionClaimsSchema.safeParse(jwtClaims(idToken ?? ""));
  if (!claims.success) return null;
  const { sub, sid, auth_time } = claims.data;
  const mac = (value: string) => createHmac("sha256", nonce).update(`${sub}\n${value}`).digest();
  return {
    ...(sid === undefined ? {} : { sid: mac(sid) }),
    ...(auth_time === undefined ? {} : { authTime: mac(String(auth_time)) }),
  };
}

/** The Host's side: a fresh nonce and its fingerprints, or null without a person. */
export function codexSessionCheck(idToken: string | null | undefined): CodexSessionCheck | null {
  const nonce = randomBytes(32);
  const prints = sessionFingerprints(nonce, idToken);
  if (!prints) return null;
  return {
    nonce: nonce.toString("base64url"),
    ...(prints.sid ? { sid: prints.sid.toString("hex") } : {}),
    ...(prints.authTime ? { authTime: prints.authTime.toString("hex") } : {}),
  };
}

/**
 * Whether a sign-in certainly belongs to another login session than the Host's: only when both
 * fingerprints are present on both sides and both differ. A missing claim or fingerprint on
 * either side counts as the same session, so its holder is held. This assumes a renewal of one
 * sign-in keeps its session ID or its authentication time.
 */
export function codexOtherSession(
  idToken: string | null | undefined,
  check: CodexSessionCheck | undefined,
): boolean {
  if (!check?.sid || !check.authTime) return false;
  const prints = sessionFingerprints(Buffer.from(check.nonce, "base64url"), idToken);
  if (!prints?.sid || !prints.authTime) return false;
  const differs = (mine: Buffer, theirs: string) => {
    const other = Buffer.from(theirs, "hex");
    return other.length !== mine.length || !timingSafeEqual(mine, other);
  };
  return differs(prints.sid, check.sid) && differs(prints.authTime, check.authTime);
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
