import { expect, test } from "vitest";
import type { DashboardSample } from "@getpaseo/protocol/messages";
import { getDashboardWindow } from "./history";

test("keeps gaps between hours and UTC days, including a metric missing from the final observation", () => {
  const earlier = { at: "2026-11-23T22:00:00.000Z", values: { active: 4 }, unavailable: [] };
  const midday = { at: "2026-11-25T12:00:00.000Z", values: { active: 0 }, unavailable: [] };
  const latest = { at: "2026-11-25T14:00:00.000Z", values: {}, unavailable: ["Source offline"] };
  const samples = [latest, earlier, midday];

  const hourly = getDashboardWindow(samples, 1);
  expect(hourly.points.slice(-3).map(({ sample }) => sample)).toEqual([midday, undefined, latest]);
  expect(hourly.keys).toEqual(["active"]);

  const daily = getDashboardWindow(samples, 7);
  expect(daily.points.slice(-3).map(({ sample }) => sample)).toEqual([earlier, undefined, latest]);
  expect(daily.latest).toEqual(latest);
  expect(daily.keys).toEqual(["active"]);
});

test("sums observed interval changes per UTC day and counts reported hours including zero", () => {
  const samples: DashboardSample[] = [
    { at: "2026-11-24T23:55:00.000Z", values: { intervalTokens: 2 }, unavailable: [] },
    { at: "2026-11-25T00:10:00.000Z", values: { intervalTokens: 99 }, unavailable: [] },
    { at: "2026-11-25T00:20:00.000Z", values: { intervalTokens: 3 }, unavailable: [] },
    { at: "2026-11-25T02:00:00.000Z", values: { intervalTokens: 0 }, unavailable: [] },
    { at: "2026-11-25T03:00:00.000Z", values: {}, unavailable: [] },
  ];
  const { latest, points } = getDashboardWindow(samples, 7);
  const [missing, previous, current] = points.slice(-3);
  expect(missing?.intervals?.get("intervalTokens")).toBeUndefined();
  expect(previous?.intervals?.get("intervalTokens")).toEqual({ sum: 2, hours: 1 });
  expect(current?.intervals?.get("intervalTokens")).toEqual({ sum: 3, hours: 2 });
  expect(latest).toBe(samples.at(-1));
});
