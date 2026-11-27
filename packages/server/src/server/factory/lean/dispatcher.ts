import type {
  DispatchAction,
  DispatchContext,
  IssueStage,
  PlanActions,
  RunnerRole,
} from "./types.js";

function action(issue: number, stage: IssueStage, ctx: DispatchContext): DispatchAction | null {
  const open = (role: RunnerRole, reason: string): DispatchAction => ({
    kind: "open-runner",
    issue,
    role,
    reason,
    brief: reason,
  });
  switch (stage.kind) {
    case "approved":
      return ctx.lanesHeld.has("merge")
        ? {
            kind: "merge",
            issue,
            pr: stage.pr,
            verdict: stage.verdict,
            acceptance: stage.acceptance,
          }
        : null;
    case "accepting":
      return stage.session
        ? null
        : open("foreman-op", "Judge the reviewed commit against recorded owner intent.");
    case "review":
      return stage.reviewer
        ? null
        : open("reviewer", "Review the exact pull request head independently.");
    case "repair":
      return stage.lead
        ? { kind: "send-repair", issue, lead: stage.lead, findings: stage.findings }
        : open("lead", "Repair the pull request.");
    case "sent-back":
      return {
        kind: "deliver-send-back",
        issue,
        sha: stage.pr.headSha,
        improvements: stage.improvements,
        lead: stage.lead,
      };
    case "plan-ready":
      return { kind: "send-go", issue, lead: stage.lead, files: stage.files };
    case "claimed":
      return open("lead", "Plan the admitted issue and wait for permission to build.");
    case "queued":
      return ctx.lanesHeld.has("intake") ? { kind: "claim", issue } : null;
    default:
      return null;
  }
}

export const plan: PlanActions = (stages, _ledger, ctx) => {
  const order: IssueStage["kind"][] = [
    "approved",
    "accepting",
    "review",
    "repair",
    "sent-back",
    "plan-ready",
    "claimed",
    "queued",
  ];
  const actions: DispatchAction[] = [];
  for (const kind of order) {
    for (const [issue, stage] of stages) {
      if (stage.kind !== kind) continue;
      const next = action(issue, stage, ctx);
      if (next) actions.push(next);
    }
  }
  return actions;
};
