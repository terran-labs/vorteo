import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePath = z.string().startsWith("/");
const File = z.strictObject({ path: AbsolutePath, sha256: Digest });
const Directory = z.strictObject({
  inode: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777),
});
export const PreviewBrokerAnchorSchema = z.strictObject({
  version: z.literal(1),
  filesystem: z.literal("apfs"),
  volumeUUID: z.string().uuid(),
  mountPoint: AbsolutePath,
  ancestors: z.record(AbsolutePath, Directory),
  directories: z.strictObject({
    "": Directory,
    inbox: Directory,
    receipts: Directory,
    origins: Directory,
  }),
});
const Broker = z.strictObject({
  configPath: AbsolutePath,
  fencePath: AbsolutePath,
  expectedSha256: Digest,
  candidateSha256: Digest,
  anchor: PreviewBrokerAnchorSchema,
});
export const PreviewBrokerPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("preview-broker-channel-rebind"),
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  evidenceDirectory: AbsolutePath,
  continuityEvidence: z.array(File).min(1).max(8),
  brokers: z.tuple([Broker, Broker]),
});
export type PreviewBrokerPlan = z.infer<typeof PreviewBrokerPlanSchema>;
export const PreviewBrokerPreparationSchema = z
  .strictObject({
    id: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
    plan: PreviewBrokerPlanSchema,
  })
  .refine((value) => value.id === value.plan.id, "Request and plan identity differ");
export const PreviewBrokerDecisionSchema = z.strictObject({
  operation: z.literal("preview-broker-channel-rebind"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: Digest,
  decision: z.enum(["approve", "cancel"]),
});
export const PreviewBrokerObservationSchema = z
  .strictObject({
    kind: z.enum(["precommit-held", "committed", "unresolved"]),
    id: z.string().uuid(),
    planSha256: Digest,
    workerPlanSha256: Digest,
    commitSha256: Digest.optional(),
    configSelections: z
      .tuple([z.enum(["original", "candidate"]), z.enum(["original", "candidate"])])
      .optional(),
    inventorySha256: z.array(Digest).min(1).max(2).optional(),
    reason: z.enum(["commit-absent", "commit-confirmed", "evidence-unconfirmed"]),
  })
  .superRefine((value, ctx) => {
    if (
      value.kind === "committed" &&
      (!value.commitSha256 ||
        value.reason !== "commit-confirmed" ||
        value.configSelections?.some((item) => item !== "candidate") ||
        value.configSelections?.length !== 2 ||
        value.inventorySha256?.length !== 2)
    )
      ctx.addIssue({ code: "custom", message: "Committed observation requires complete proof" });
    if (
      value.kind === "precommit-held" &&
      (value.reason !== "commit-absent" ||
        !value.configSelections ||
        value.inventorySha256?.length !== 1)
    )
      ctx.addIssue({ code: "custom", message: "Held observation requires fence proof" });
  });
export type PreviewBrokerObservation = z.infer<typeof PreviewBrokerObservationSchema>;
export const PreviewBrokerJobSchema = z.strictObject({
  target: z.literal("preview-broker"),
  operation: z.literal("preview-broker-channel-rebind"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
  plan: PreviewBrokerPlanSchema,
  planSha256: Digest,
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  stage: z.enum(["preparing", "prepared", "dispatch_pending", "succeeded", "recovery_required"]),
  detail: z.string(),
  observation: PreviewBrokerObservationSchema.optional(),
});
export type PreviewBrokerJob = z.infer<typeof PreviewBrokerJobSchema>;
export const PreviewBrokerConfigurationSchema = z.strictObject({
  docker: AbsolutePath,
  socket: AbsolutePath,
  containerId: Digest,
  configPaths: z.tuple([AbsolutePath, AbsolutePath]),
  python: File,
  worker: File,
  identityModule: File,
  // Installed consumers must include the stable verifier and locked config reload.
  consumerFiles: z.array(File).min(6).max(12),
  evidenceRoot: AbsolutePath,
  recovery: z.strictObject({ node: File, journal: File, queue: File, configModule: File }),
});
export type PreviewBrokerConfiguration = z.infer<typeof PreviewBrokerConfigurationSchema>;
