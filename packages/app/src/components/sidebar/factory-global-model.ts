import type { ProjectFactoryList } from "../../../../../plugins/factory/shared/project";
import {
  factoryCardKey,
  factoryRunners,
  factoryStatePill,
  type FactoryQueueIssue,
  type FactoryStatePill,
} from "./factory-card-model";
import type { ProjectFactoryState } from "./factory-state";

type ListedFactory = ProjectFactoryList["projects"][number];

/** One project's Factory as the All Factories card sees it. */
export interface FactorySummaryInput {
  serverId: string;
  projectId: string;
  projectName: string;
  /** Set when several hosts run Factories, so chips can tell them apart. */
  hostLabel: string | null;
  listed: Pick<ListedFactory, "state" | "drain">;
  /** The project's full state, once read. */
  state?: Pick<ProjectFactoryState, "roles" | "reason">;
  /** Null until read, or when the queue is unavailable. */
  issues: readonly FactoryQueueIssue[] | null;
}

/** An issue tagged with the Factory it belongs to, so merged lists stay distinguishable. */
export type TaggedFactoryIssue = FactoryQueueIssue & { serverId: string; tag: string };

export interface FactoryChipSummary {
  key: string;
  serverId: string;
  projectId: string;
  name: string;
  hostLabel: string | null;
  pill: FactoryStatePill;
  /** The daemon's reason or drain reason, for the chip's tooltip. */
  reason: string | null;
  /** Another process, such as Builds before a restart, holds this Factory. */
  held: boolean;
  inFlight: number;
}

export interface FactoryAggregate {
  pill: FactoryStatePill;
  issues: TaggedFactoryIssue[];
  runners: TaggedFactoryIssue[];
  chips: FactoryChipSummary[];
}

/** A Factory counts once it is on or paused, including a drained one. */
export function isListedFactory(project: Pick<ListedFactory, "state" | "drain">): boolean {
  return project.state === "on" || project.state === "paused" || project.drain !== null;
}

/**
 * Every Factory merged into one card: On only when all are on, Paused when any is paused or
 * drained, otherwise Off. Issues and runners keep their project's tag.
 */
export function aggregateFactories(factories: readonly FactorySummaryInput[]): FactoryAggregate {
  const tagged = factories.map((factory) => {
    const tag = factory.hostLabel
      ? `${factory.projectName} · ${factory.hostLabel}`
      : factory.projectName;
    const issues = (factory.issues ?? []).map(
      (issue): TaggedFactoryIssue => Object.assign({}, issue, { serverId: factory.serverId, tag }),
    );
    return { factory, tag, issues };
  });
  const pills = factories.map((factory) => factoryStatePill(factory.listed));
  let pill: FactoryStatePill = { label: "off", variant: "muted" };
  if (pills.some((entry) => entry.variant === "warning")) {
    pill = { label: "paused", variant: "warning" };
  } else if (pills.length > 0 && pills.every((entry) => entry.label === "on")) {
    pill = { label: "on", variant: "success" };
  }
  const issues = tagged.flatMap((entry) => entry.issues);
  return {
    pill,
    issues,
    runners: factoryRunners(issues),
    chips: tagged.map(({ factory, issues: own }, index) => ({
      key: factoryCardKey(factory.serverId, factory.projectId),
      serverId: factory.serverId,
      projectId: factory.projectId,
      name: factory.projectName,
      hostLabel: factory.hostLabel,
      pill: pills[index]!,
      reason: factory.listed.drain?.reason ?? factory.state?.reason ?? null,
      held: pills[index]!.label === "held",
      inFlight: factoryRunners(own).length,
    })),
  };
}

/** Immediate status does not depend on queue reads, which paused Factories intentionally skip. */
export function factorySummaryState(factories: readonly FactorySummaryInput[]) {
  const running = factories.filter(
    (factory) => factory.listed.state === "on" && !factory.listed.drain,
  ).length;
  const held = factories.filter((factory) => factory.listed.drain !== null).length;
  return {
    count: factories.length,
    running,
    paused: factories.length - running,
    held,
    hasQueue: factories.some((factory) => factory.issues !== null),
  };
}
