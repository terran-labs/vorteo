export interface ScriptRuntimeEntry {
  workspaceId: string;
  scriptName: string;
  type: "script" | "service";
  lifecycle: "running" | "stopped";
  terminalId: string;
  exitCode: number | null;
  // Set for a service launched with a marker, so a replacement daemon may re-link it. Only the
  // launcher and the re-link set it; plain scripts never survive a daemon.
  service?: SurvivingServiceDetails;
  // The owner asked to stop it. It stays running until its terminal exits, but it is out of
  // the durable record, so a daemon replaced mid-stop never brings it back.
  stopRequested?: true;
}

export interface SurvivingServiceDetails {
  // The nonce of the launch marker the terminal worker holds for this service's terminal.
  launchNonce: string;
}

export type RunningService = Pick<ScriptRuntimeEntry, "workspaceId" | "scriptName" | "terminalId"> &
  SurvivingServiceDetails;

interface RuntimeEntryKey {
  workspaceId: string;
  scriptName: string;
}

export class WorkspaceScriptRuntimeStore {
  private readonly entries = new Map<string, ScriptRuntimeEntry>();
  private readonly scriptsByWorkspace = new Map<string, Set<string>>();
  private persist: ((services: RunningService[]) => void) | null = null;

  get(key: RuntimeEntryKey): ScriptRuntimeEntry | null {
    const entry = this.entries.get(this.toEntryKey(key));
    return entry ? { ...entry } : null;
  }

  set(entry: ScriptRuntimeEntry): void {
    const workspaceKey = this.toWorkspaceKey(entry.workspaceId);
    const entryKey = this.toEntryKey(entry);
    const previous = this.entries.get(entryKey);
    if (previous) {
      this.removeScriptFromWorkspaceIndex(previous.workspaceId, previous.scriptName);
    }

    this.entries.set(entryKey, { ...entry });
    this.addScriptToWorkspaceIndex(workspaceKey, entry.scriptName);
    this.publishRunningServices();
  }

  /** Withdraws a running service from the durable record before its owner's stop kills it. */
  markStopRequested(key: RuntimeEntryKey): void {
    const entry = this.entries.get(this.toEntryKey(key));
    if (!entry) return;
    entry.stopRequested = true;
    this.publishRunningServices();
  }

  /**
   * Reports every running service a replacement daemon may re-link, now and after each change.
   * The daemon installs this once its startup re-link is done, so a write never drops a record
   * that has not been read yet.
   */
  persistRunningServices(persist: (services: RunningService[]) => void): void {
    this.persist = persist;
    this.publishRunningServices();
  }

  remove(key: RuntimeEntryKey): void {
    const entryKey = this.toEntryKey(key);
    const existing = this.entries.get(entryKey);
    if (!existing) {
      return;
    }

    this.entries.delete(entryKey);
    this.removeScriptFromWorkspaceIndex(existing.workspaceId, existing.scriptName);
    this.publishRunningServices();
  }

  listForWorkspace(workspaceId: string): ScriptRuntimeEntry[] {
    const scriptNames = this.scriptsByWorkspace.get(this.toWorkspaceKey(workspaceId));
    if (!scriptNames) {
      return [];
    }

    const entries: ScriptRuntimeEntry[] = [];
    for (const scriptName of scriptNames) {
      const entry = this.entries.get(
        this.toEntryKey({
          workspaceId,
          scriptName,
        }),
      );
      if (entry) {
        entries.push({ ...entry });
      }
    }
    return entries;
  }

  removeForWorkspace(workspaceId: string): void {
    for (const entry of this.listForWorkspace(workspaceId)) {
      this.entries.delete(this.toEntryKey(entry));
    }
    this.scriptsByWorkspace.delete(this.toWorkspaceKey(workspaceId));
    this.publishRunningServices();
  }

  isRunning(key: RuntimeEntryKey): boolean {
    return this.get(key)?.lifecycle === "running";
  }

  private publishRunningServices(): void {
    if (!this.persist) return;
    const services: RunningService[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lifecycle !== "running" || !entry.service || entry.stopRequested) continue;
      services.push({
        workspaceId: entry.workspaceId,
        scriptName: entry.scriptName,
        terminalId: entry.terminalId,
        ...entry.service,
      });
    }
    this.persist(services);
  }

  private addScriptToWorkspaceIndex(workspaceKey: string, scriptName: string): void {
    const scripts = this.scriptsByWorkspace.get(workspaceKey) ?? new Set<string>();
    scripts.add(scriptName);
    this.scriptsByWorkspace.set(workspaceKey, scripts);
  }

  private removeScriptFromWorkspaceIndex(workspaceId: string, scriptName: string): void {
    const workspaceKey = this.toWorkspaceKey(workspaceId);
    const scripts = this.scriptsByWorkspace.get(workspaceKey);
    if (!scripts) {
      return;
    }

    scripts.delete(scriptName);
    if (scripts.size === 0) {
      this.scriptsByWorkspace.delete(workspaceKey);
    }
  }

  private toEntryKey(key: RuntimeEntryKey): string {
    return `${this.toWorkspaceKey(key.workspaceId)}::${key.scriptName}`;
  }

  private toWorkspaceKey(workspaceId: string): string {
    return workspaceId;
  }
}
