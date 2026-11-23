import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The real Unistyles web stylesheet and listener, as patched in
// patches/react-native-unistyles+3.2.4.patch. The package exports neither file, and the
// `react-native-unistyles` test double replaces the bare name, so load them by path.
const packageRoot = path.dirname(
  createRequire(import.meta.url).resolve("react-native-unistyles/package.json"),
);
interface Stylesheet {
  add: (hash: string, values: Record<string, unknown>) => void;
  getStyles: () => string;
  batchDepth: number;
}
interface Listener {
  addListeners: (dependencies: number[], listener: () => void) => () => void;
  emitChanges: (dependencies: number[]) => void;
}
let CSSState: new (services: unknown) => Stylesheet;
let UnistylesListener: new (services: unknown) => Listener;

beforeAll(async () => {
  // The web entry first: its modules import each other in a cycle that only resolves from there.
  await import(path.join(packageRoot, "lib/module/web/index.js"));
  ({ CSSState } = await import(path.join(packageRoot, "lib/module/web/css/state.js")));
  ({ UnistylesListener } = await import(path.join(packageRoot, "lib/module/web/listener.js")));
});

const THEME = 0;
const COMPONENTS = 40;

function createStylesheet() {
  let rebuilds = 0;
  const styleTag = {} as { innerText: string };
  Object.defineProperty(styleTag, "innerText", {
    set: () => {
      rebuilds += 1;
    },
  });
  // The stylesheet attaches to a style tag only in a browser, so give it one to write to.
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { getElementById: () => styleTag });
  const services = { runtime: { miniRuntime: {} } } as Record<string, unknown>;
  const css = new CSSState(services);
  vi.unstubAllGlobals();
  services.registry = { css };
  const listener = new UnistylesListener(services);
  return { css, listener, rebuilds: () => rebuilds };
}

describe("Unistyles web theme changes (#609)", () => {
  // A theme or breakpoint change restyles every mounted component inside one emit. The
  // stock library rebuilt the whole sheet per component, which froze a resize for seconds.
  it("rebuilds the stylesheet once per emit, even when a subscriber throws", () => {
    const { css, listener, rebuilds } = createStylesheet();
    for (let index = 0; index < COMPONENTS; index += 1) {
      listener.addListeners([THEME], () => css.add(`style-${index}`, { color: "red" }));
    }
    listener.emitChanges([THEME]);
    expect(rebuilds()).toBe(1);
    expect(css.getStyles()).toContain(`style-${COMPONENTS - 1}`);

    listener.addListeners([THEME], () => {
      throw new Error("subscriber failed");
    });
    expect(() => listener.emitChanges([THEME])).toThrow("subscriber failed");
    expect(rebuilds()).toBe(2);
    expect(css.batchDepth).toBe(0);
  });
});
