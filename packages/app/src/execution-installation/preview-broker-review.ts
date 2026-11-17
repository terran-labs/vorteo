import type { PreviewBrokerDeploymentJob } from "@getpaseo/protocol/preview-broker-deployment";
import type { PreviewBrokerJob } from "@getpaseo/protocol/preview-broker-maintenance";
export type BrokerReviewJob = PreviewBrokerJob | PreviewBrokerDeploymentJob;
export type BrokerAction = "approve" | "cancel";
export function brokerActionDisabledReason(
  job: Pick<BrokerReviewJob, "status" | "stage">,
  action: BrokerAction,
  state: { busy: boolean; unlocked: boolean },
): string | null {
  if (state.busy) return "Wait for the current action, then refresh its result.";
  if (!state.unlocked) return "Unlock Installation controls to review this broker request.";
  if (action === "cancel")
    return ["pending", "approved"].includes(job.status)
      ? null
      : "This request has dispatched or finished. Inspect its receipt.";
  return job.status === "pending" && job.stage === "prepared"
    ? null
    : "Approval requires the current prepared broker request.";
}
export function brokerReviewSummary(
  job: Pick<BrokerReviewJob, "status" | "stage"> & { target?: BrokerReviewJob["target"] },
): string {
  if (job.stage === "recovery_required")
    return "Broker outcome needs inspection. Retained bytes and receipt remain available. Never replay or roll back automatically.";
  if (job.target === "preview-broker-deployment") {
    if (job.status === "succeeded")
      return "Consumer files and registration restoration verified. Channel trust and preview readiness require separate acceptance.";
    if (job.status === "running")
      return "Replacing the approved broker consumers within their maintenance window.";
    if (job.status === "rejected") return "Consumer deployment canceled.";
    if (job.status === "failed") return "Deployment preparation failed. Inspect the receipt.";
    return "Replace eight broker consumer files and restore the reviewed broker registrations. Channel trust approval is separate. Partial outcomes remain held for inspection.";
  }
  if (job.status === "succeeded")
    return "Both broker configs are verified. Service availability still requires acceptance.";
  if (job.status === "running")
    return "Replacing and verifying the approved preview broker. Host and Dev agents keep running.";
  if (job.status === "rejected") return "Preview broker replacement canceled.";
  if (job.status === "failed")
    return "Preparation failed. Inspect the artifacts and prepare a new request.";
  return "Bind both preview channels to the reviewed APFS volume and directory identities. Configs change sequentially; partial failure requires inspection. Hostname and service state stay unchanged.";
}

type BrokerAdmission = PreviewBrokerDeploymentJob["plan"]["registrations"][number]["admission"];

/** What approving a registration does to request handling, by its channel admission. */
export function brokerAdmissionDescription(admission: BrokerAdmission): string {
  return admission === "running"
    ? "Admission: running. Its legacy channel identity verifies, so this broker restarts on the new consumer code and serves preview requests immediately."
    : "Admission: refusing. Its legacy channel identity still refuses, so this broker keeps refusing requests until channel trust is approved separately.";
}

export function brokerDeploymentResumeDescription(
  registrations: readonly { admission?: BrokerAdmission }[],
): string {
  return registrations.some((item) => item.admission === "running")
    ? "Brokers marked running restart on the new consumer code and serve requests as soon as the maintenance window closes. Brokers marked refusing keep refusing until channel trust is approved."
    : "Resume is allowed only while legacy channel identity still refuses request consumption.";
}
