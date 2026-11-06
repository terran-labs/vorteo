import { ProviderSecretsConflictError } from "./provider-secrets-authority.js";
import { SPEECH_SECRETS_IMPORT_ROUTE } from "./speech-secrets-adoption.js";
import type { ErrorRequestHandler, Express, Request } from "express";
import {
  ProviderSecretClearRequestSchema,
  ProviderSecretSetRequestSchema,
  ProviderSecretsReadRequestSchema,
} from "@getpaseo/protocol/provider-secrets";
import {
  ProviderSecretsDefinitionMissing,
  type ProviderSecretsRuntime,
} from "./provider-secrets-runtime.js";

export const PROVIDER_SECRETS_OWNER_ROOT = "/api/installation/owner/provider-secrets";

/** Must be mounted after the installation owner Origin/session gate. */
export function mountProviderSecretsRoutes(
  app: Express,
  runtime: ProviderSecretsRuntime,
  agent?: (req: Request) => { kind: "host" | "container"; serverId: string } | null,
): void {
  const root = PROVIDER_SECRETS_OWNER_ROOT;
  app.post(SPEECH_SECRETS_IMPORT_ROUTE, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const kind = agent?.(req);
    if (!kind) {
      res.sendStatus(401);
      return;
    }
    try {
      runtime.acceptSpeechAdoption(req.body, kind);
      res.json({ accepted: true });
    } catch {
      res.status(409).json({ error: "Voice key adoption is no longer pending." });
    }
  });
  const parseFailure: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.sendStatus(400);
  };
  app.use(root, parseFailure);
  app.use(SPEECH_SECRETS_IMPORT_ROUTE, parseFailure);
  const handlers = {
    read: (body: unknown) => {
      const input = ProviderSecretsReadRequestSchema.safeParse(body ?? {});
      return input.success
        ? () => Promise.resolve().then(() => runtime.read(input.data.definitionId, input.data.kind))
        : null;
    },
    set: (body: unknown) => {
      const input = ProviderSecretSetRequestSchema.safeParse(body);
      if (!input.success) return null;
      const value = input.data;
      return value.kind === "speech"
        ? () => runtime.setSpeech(value.sites)
        : () => runtime.set(value.definitionId, value.name, value.value);
    },
    clear: (body: unknown) => {
      const input = ProviderSecretClearRequestSchema.safeParse(body);
      return input.success
        ? () =>
            runtime.clear(
              input.data.definitionId,
              input.data.name,
              input.data.kind,
              input.data.kind === "speech" ? input.data.expectedRevision : undefined,
            )
        : null;
    },
  };
  for (const [operation, parse] of Object.entries(handlers)) {
    app.post(`${root}/${operation}`, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const run = parse(req.body);
      if (!run) {
        // Validation details could echo a submitted value. Return a fixed message.
        res.status(400).json({
          error:
            "Enter a key name ending in _KEY, _TOKEN, _SECRET or _PASSWORD and a value without surrounding spaces or line breaks.",
        });
        return;
      }
      run().then(
        (definitions) => res.json({ definitions }),
        (error: unknown) => {
          if (error instanceof ProviderSecretsConflictError) {
            res.status(409).json({ error: error.message });
            return;
          }
          if (error instanceof ProviderSecretsDefinitionMissing) {
            res.status(404).json({ error: "This connection no longer exists. Reload Settings." });
            return;
          }
          // Neither values nor value-bearing exceptions enter HTTP logs.
          res
            .status(409)
            .json({ error: "Shared keys could not be saved. Reload Settings and try again." });
        },
      );
    });
  }
}
