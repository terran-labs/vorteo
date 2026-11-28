/** Scan a few known claim refs per pass, including claims this primary never built. */
export function createClosedClaimCleanup(options: {
  now(): Date;
  holdsPrimary(): Promise<boolean>;
  listIssues(): Promise<Array<{ issue: number; revision: string }>>;
  isClosedIssue(issue: number): Promise<boolean>;
  remove(issue: number, expectedRevision: string): Promise<boolean>;
}) {
  let nextScan = 0;
  let lastIssue = 0;
  let running: Promise<void> | undefined;
  async function scan() {
    if (!(await options.holdsPrimary())) return;
    nextScan = options.now().getTime() + 10 * 60_000;
    const issues = await options.listIssues();
    const next = issues.findIndex((entry) => entry.issue > lastIssue);
    const start = next < 0 ? 0 : next;
    for (let offset = 0; offset < Math.min(issues.length, 12); offset++) {
      const { issue, revision } = issues[(start + offset) % issues.length];
      lastIssue = issue;
      if (!(await options.isClosedIssue(issue))) continue;
      if (!(await options.holdsPrimary())) return;
      // The Git CAS leaves a claim acquired after this scan intact.
      await options.remove(issue, revision);
    }
  }
  return function reconcile() {
    if (running) return running;
    if (options.now().getTime() < nextScan) return Promise.resolve();
    running = scan().finally(() => {
      running = undefined;
    });
    return running;
  };
}
