import type { ErrorRequestHandler, Express, Response } from "express";
import { z } from "zod";
import { CodexAdoptionBusy, type CodexAdoptionRecord } from "./codex-signin-adoption.js";
import { HOST_SIGN_IN_REASONS } from "./codex-signin-host.js";
import type { CodexSignInRuntime } from "./codex-signin-runtime.js";

const Definition = z.strictObject({ definitionId: z.string().min(1).max(512) });
const Attempt = Definition.extend({ attemptId: z.string().uuid() });
const Empty = z.strictObject({});

const SIGN_IN_FAILURE = "Codex sign-in could not complete. Refresh and try again.";
const ADOPTION_FAILURE = "Could not finish switching this account. Refresh and try again.";

/**
 * What the owner's app sees of an adoption: its state, plain reason and times. Never the account
 * ID, email, token, provider IDs or Dev's pinned directory.
 */
function adoptionView(record: CodexAdoptionRecord) {
  return {
    status: record.status,
    error: record.error,
    startedAt: record.startedAt,
    projectedAt: record.projectedAt,
    renewedAt: record.renewedAt,
    provenAt: record.provenAt,
    copyForgottenAt: record.copyForgottenAt,
    restored: record.restored,
    ...(record.restoreSkipped ? { restoreSkipped: true as const } : {}),
    ...(record.copyDeleteBlocked ? { copyDeleteBlocked: record.copyDeleteBlocked } : {}),
    // A failure a Host sign-in repairs; the app offers "Sign in on the Host" beside it.
    ...(record.status === "failed" && record.error && HOST_SIGN_IN_REASONS.has(record.error)
      ? { hostSignInNeeded: true as const }
      : {}),
  };
}

/** A failed record answers 409 with its plain reason, beside the record itself. */
function sendAdoption(res: Response, record: CodexAdoptionRecord): void {
  const adoption = adoptionView(record);
  if (record.status === "failed")
    res.status(409).json({ error: record.error ?? ADOPTION_FAILURE, adoption });
  else res.json({ adoption });
}

/**
 * Must be mounted after the installation owner Origin/session gate. Codex signs in with a device
 * code, so there is no code submission route. Adoption of a legacy account is reachable only
 * here, never from a daemon route, tool or CLI.
 */
export function mountCodexSignInRoutes(app: Express, runtime: CodexSignInRuntime): void {
  const root = "/api/installation/owner/codex/signin";
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(root, parseFailure);
  for (const operation of ["read", "start", "cancel", "sign-out"] as const) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      void (async () => {
        try {
          if (operation === "cancel") {
            const input = Attempt.parse(req.body);
            res.json(await runtime.cancel(input.definitionId, input.attemptId));
            return;
          }
          const input = Definition.parse(req.body);
          if (operation === "read") res.json(runtime.read(input.definitionId));
          else if (operation === "start") res.json(await runtime.start(input.definitionId));
          else {
            const warning = await runtime.signOut(input.definitionId);
            res.json({ ...runtime.read(input.definitionId), ...(warning ? { warning } : {}) });
          }
        } catch {
          // Token-bearing exceptions never enter HTTP logs.
          res.status(409).json({ error: SIGN_IN_FAILURE });
        }
      })();
    });
  }
  for (const operation of ["adoptions", "adopt", "unadopt"] as const) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      void (async () => {
        try {
          if (operation === "adoptions") {
            Empty.parse(req.body ?? {});
            res.json({
              definitions: runtime.adoptions().map((item) => ({
                definitionId: item.definitionId,
                eligible: item.reason === null,
                reason: item.reason,
                adoption: item.record ? adoptionView(item.record) : null,
              })),
            });
            return;
          }
          const { definitionId } = Definition.parse(req.body);
          sendAdoption(
            res,
            operation === "adopt"
              ? await runtime.adopt(definitionId)
              : await runtime.unadopt(definitionId),
          );
        } catch (error) {
          // Only the busy refusal's fixed text is passed on; nothing else reaches logs or replies.
          res
            .status(error instanceof z.ZodError ? 400 : 409)
            .json({ error: error instanceof CodexAdoptionBusy ? error.message : ADOPTION_FAILURE });
        }
      })();
    });
  }
}
