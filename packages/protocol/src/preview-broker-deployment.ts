import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const AbsolutePath = z.string().startsWith("/");
const File = z.strictObject({ path: AbsolutePath, sha256: Digest });
const Integer = z.number().int().nonnegative();
const DirectoryIdentity = z.tuple([Integer, Integer, Integer, Integer, Integer]);
const DecimalIdentity = z.string().regex(/^(0|[1-9][0-9]*)$/);
// Nanosecond timestamps exceed JavaScript safe integers; retain exact decimal bytes.
const FileIdentity = z.tuple([
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
  DecimalIdentity,
]);
const Preimage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent") }),
  z.strictObject({ kind: z.literal("present"), sha256: Digest, identity: FileIdentity }),
]);
const Consumer = z.strictObject({
  expected: Preimage,
  candidate: File,
  mode: z.union([z.literal(0o600), z.literal(0o644), z.literal(0o700), z.literal(0o755)]),
});
const Target = z.strictObject({
  root: AbsolutePath,
  directory: DirectoryIdentity,
  preservationSha256: Digest,
  files: z.strictObject({
    "https_broker.py": Consumer,
    "https-preview.py": Consumer,
    "host_config.py": Consumer,
    "channel_identity.py": Consumer,
  }),
});
const Process = z.strictObject({
  pid: z.number().int().positive(),
  birth: z.tuple([Integer, Integer]),
  uid: Integer,
  argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
});
const Registration = z.strictObject({
  root: AbsolutePath,
  domain: z.string().regex(/^gui\/[0-9]+$/),
  label: z.string().regex(/^[a-zA-Z0-9.-]+$/),
  enabled: z.boolean(),
  override: z.enum(["absent", "enabled", "disabled"]),
  plist: File,
  disposition: z.enum(["loaded", "absent"]),
  process: Process.nullable(),
});
export const PreviewBrokerDeploymentPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("preview-broker-consumer-deployment"),
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  evidenceDirectory: AbsolutePath,
  evidenceDirectoryIdentity: DirectoryIdentity,
  bootUUID: z.string().uuid(),
  targets: z.tuple([Target, Target]),
  registrations: z.tuple([Registration, Registration]),
  // Finite declared routes and manual participants, never an OS-wide import claim.
  participantEvidence: z.array(File).min(1).max(16),
  manualParticipants: z.array(Process).max(128),
});
export type PreviewBrokerDeploymentPlan = z.infer<typeof PreviewBrokerDeploymentPlanSchema>;
export const PreviewBrokerDeploymentPreparationSchema = z
  .strictObject({
    id: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
    plan: PreviewBrokerDeploymentPlanSchema,
  })
  .refine((value) => value.id === value.plan.id, "Request and deployment identity differ");
export const PreviewBrokerDeploymentDecisionSchema = z.strictObject({
  operation: z.literal("preview-broker-consumer-deployment"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  planSha256: Digest,
  decision: z.enum(["approve", "cancel"]),
});
export const PreviewBrokerDeploymentObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("committed"),
    id: z.string().uuid(),
    planSha256: Digest,
    commitSha256: Digest,
    preservationSha256: Digest,
    registrationsSha256: Digest,
    installedFilesSha256: Digest,
  }),
  z.strictObject({
    kind: z.literal("unresolved"),
    id: z.string().uuid(),
    planSha256: Digest,
    reason: z.enum([
      "intent-only",
      "files-partial",
      "registration-unconfirmed",
      "evidence-unconfirmed",
    ]),
  }),
]);
export type PreviewBrokerDeploymentObservation = z.infer<
  typeof PreviewBrokerDeploymentObservationSchema
>;
export const PreviewBrokerDeploymentJobSchema = z.strictObject({
  target: z.literal("preview-broker-deployment"),
  operation: z.literal("preview-broker-consumer-deployment"),
  id: z.string().uuid(),
  revision: z.string().uuid(),
  requestedBy: z.literal("host-agent"),
  reason: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
  plan: PreviewBrokerDeploymentPlanSchema,
  planSha256: Digest,
  status: z.enum(["pending", "approved", "running", "succeeded", "failed", "rejected"]),
  stage: z.enum(["preparing", "prepared", "dispatch_pending", "succeeded", "recovery_required"]),
  detail: z.string(),
  observation: PreviewBrokerDeploymentObservationSchema.optional(),
});
export type PreviewBrokerDeploymentJob = z.infer<typeof PreviewBrokerDeploymentJobSchema>;
export const BrokerDeploymentBindingSchema = z.strictObject({
  root: AbsolutePath,
  domain: z.string().regex(/^gui\/[0-9]+$/),
  label: z.string().regex(/^[a-zA-Z0-9.-]+$/),
  plist: File,
  interpreter: AbsolutePath,
  argv: z.array(z.string()).length(3),
});
export const BrokerDeploymentScopeSchema = z.strictObject({
  version: z.literal(1),
  installationId: z.string().uuid(),
  requestId: z.string().uuid(),
  bootUUID: z.string().uuid(),
  validUntil: z.string().datetime(),
  declaration: z.literal(
    "Only the declared managed routes and manual participants are known; no new manual broker calls until release",
  ),
  bindings: z.tuple([BrokerDeploymentBindingSchema, BrokerDeploymentBindingSchema]),
  manualParticipants: z.array(Process).max(128),
});
export const PreviewBrokerDeploymentConfigurationSchema = z.strictObject({
  docker: AbsolutePath,
  socket: AbsolutePath,
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  roots: z.tuple([AbsolutePath, AbsolutePath]),
  bindings: z.tuple([BrokerDeploymentBindingSchema, BrokerDeploymentBindingSchema]),
  scope: File,
  nativeInspector: File,
  python: File,
  worker: File,
  modules: z.array(File).min(1).max(12),
  evidenceRoot: AbsolutePath,
  recovery: z.strictObject({ node: File, journal: File, queue: File, configModule: File }),
});
