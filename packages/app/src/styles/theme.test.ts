import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { logoPalette } from "../components/icons/vorteo-logo-palette";
import { describe, expect, it } from "vitest";
import {
  darkTheme,
  FONT_SIZE,
  getNextThemePreference,
  lightTheme,
  THEME_OPTIONS,
  type Theme,
} from "./theme";
import { APPEARANCE_DEFINITIONS } from "./appearance-catalog";
import { resolveAppearanceFont } from "./appearance-font";

describe("Theme catalog", () => {
  it("selects bundled body fonts and native display fonts in authored order", () => {
    const theme = APPEARANCE_DEFINITIONS.find((appearance) => appearance.id === "scriptorium")!;
    expect(
      resolveAppearanceFont({
        stack: theme.previewBodyFont,
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("Barlow");
    expect(
      resolveAppearanceFont({
        stack: theme.previewDisplayFont,
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("BarlowCondensed-Regular");
    expect(
      resolveAppearanceFont({
        stack: theme.previewBodyFont,
        platform: "web",
        systemFont: "system-ui",
      }),
    ).toBe(theme.previewBodyFont);
  });

  it("uses native generic fallbacks when the authored families are unavailable", () => {
    expect(
      resolveAppearanceFont({
        stack: '"Unknown", serif',
        platform: "ios",
        systemFont: "system-ui",
      }),
    ).toBe("Georgia");
    expect(
      resolveAppearanceFont({
        stack: '"Optima", sans-serif',
        platform: "android",
        systemFont: "normal",
      }),
    ).toBe("normal");
    expect(
      resolveAppearanceFont({
        stack: '"Baskerville", serif',
        platform: "android",
        systemFont: "normal",
      }),
    ).toBe("serif");
  });

  it("keeps the first available family across bundled and platform fonts", () => {
    for (const platform of ["ios", "android"]) {
      for (const family of ["Barlow", "Manrope", "Space Grotesk"]) {
        expect(
          resolveAppearanceFont({
            stack: `"Unavailable", "${family}", sans-serif`,
            platform,
            systemFont: "normal",
          }),
        ).toBe(family);
      }
    }
    expect(
      resolveAppearanceFont({
        stack: '"Optima", "Manrope", sans-serif',
        platform: "ios",
        systemFont: "normal",
      }),
    ).toBe("Optima");
    expect(
      resolveAppearanceFont({
        stack: '"Unavailable", "Avenir Next", sans-serif',
        platform: "ios",
        systemFont: "normal",
      }),
    ).toBe("Avenir Next");
  });
  it("preserves the condensed trait for iOS weight matching without changing Android registration", () => {
    const stack = '"Barlow Condensed", sans-serif';
    expect(resolveAppearanceFont({ stack, platform: "ios", systemFont: "normal" })).toBe(
      "BarlowCondensed-Regular",
    );
    expect(resolveAppearanceFont({ stack, platform: "android", systemFont: "normal" })).toBe(
      "Barlow Condensed",
    );
  });
  function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map((start) => {
        const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }

  it("keeps palette logo gradients distinct against every working surface", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const palette = logoPalette(option.theme);
      if (option.name === "starship-light") {
        expect(palette.mode).toBe("rainbow");
        continue;
      }
      for (const color of [palette.start, palette.end]) {
        for (const surface of [option.theme.colors.surface0, option.theme.colors.surface3]) {
          expect(contrast(color, surface), option.name).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("keeps normal text and primary button labels readable in every palette", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const c = option.theme.colors;
      for (const surface of [c.surface0, c.surface1, c.surface2, c.surface3]) {
        expect(contrast(c.foreground, surface), option.name).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.foregroundMuted, surface), option.name).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(c.accentForeground, c.accent), option.name).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c.successForeground, c.success),
        option.name + " success button",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(c.destructiveForeground, c.destructive),
        option.name + " destructive button",
      ).toBeGreaterThanOrEqual(4.5);
      for (const signal of [c.statusSuccess, c.statusDanger, c.statusWarning, c.statusMerged]) {
        expect(contrast(signal, c.surface3), option.name + " status text").toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
  it("keeps accent-coloured text readable on every working surface", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const c = option.theme.colors;
      for (const surface of [c.surface0, c.surface1, c.surface2, c.surface3]) {
        expect(contrast(c.accentText, surface), option.name).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("offers all six reference themes and system selection without retired choices", () => {
    expect(THEME_OPTIONS.map((option) => option.name)).toEqual([
      "starship-light",
      "starship-dark",
      "scriptorium",
      "midas",
      "ember",
      "neon",
      "auto",
    ]);
    expect(getNextThemePreference("neon")).toBe("auto");
    expect(getNextThemePreference("auto")).toBe("starship-light");
  });

  it("maps every appearance to a complete semantic theme and authored typography", () => {
    for (const appearance of APPEARANCE_DEFINITIONS) {
      const option = THEME_OPTIONS.find((item) => item.name === appearance.id);
      expect(option).toBeDefined();
      if (!option || !("theme" in option)) throw new Error("Missing concrete theme");
      expect(option.theme.colorScheme).toBe(appearance.surface);
      expect(option.theme.appearance).toEqual(appearance);
      expect(option.theme.fontFamily.ui).toBeTruthy();
      expect(option.theme.fontFamily.display).toBeTruthy();
      expect(option.theme.colors.terminal.foreground).toBe(option.theme.colors.foreground);
      expect(option.theme.colors.statusDanger).not.toBe(option.theme.colors.accent);
      expect(Object.keys(option.theme.colors).sort()).toEqual(Object.keys(darkTheme.colors).sort());
    }
  });

  it("uses the Starship pair for adaptive themes and terminal/plugin defaults", () => {
    expect(lightTheme.appearance.id).toBe("starship-light");
    expect(darkTheme.appearance.id).toBe("starship-dark");
    expect(darkTheme.colors.surface0).toBe("#222222");
    expect(lightTheme.colors.surface0).toBe("#e2e2ee");
  });

  it("keeps working surfaces opaque and sidebar selection distinct", () => {
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const { colors } = option.theme;
      expect(colors.surface0).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colors.surfaceSidebarSelected).not.toBe(colors.surfaceSidebar);
      expect(colors.foreground).not.toBe(colors.surface0);
    }
  });
});

describe("Typography scale", () => {
  it("keeps the established readable size tiers", () => {
    expect(FONT_SIZE).toEqual({
      code: 12,
      content: 15,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    });
  });
});

it("keeps internal dividers quieter than borders across every appearance", () => {
  for (const option of THEME_OPTIONS) {
    if (!("theme" in option)) continue;
    const { theme } = option;
    const alpha = (color: string) => Number(color.match(/,\s*([\d.]+)\)$/)?.[1] ?? 1);
    expect(alpha(theme.colors.divider)).toBeCloseTo(alpha(theme.colors.border) * 0.55);
  }
});

it("cycles the authored appearance catalog in picker order", () => {
  for (let index = 0; index < THEME_OPTIONS.length; index++) {
    expect(getNextThemePreference(THEME_OPTIONS[index].name)).toBe(
      THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length].name,
    );
  }
});

// Vorton is the single reference for the six themes. Vorteo keeps its own adapter in theme.ts,
// and this check fails when a mapped role drifts from the vendored reference. Re-vendor with
// scripts/sync-vorton-theme-reference.mjs. Every intentional difference is declared below with
// its reason; an undeclared difference fails, and so does an exception that no longer differs.
describe("Vorton theme reference", () => {
  const referenceUrl = new URL("./vorton-theme-reference.json", import.meta.url);
  const referenceText = readFileSync(referenceUrl, "utf8");
  const source = JSON.parse(
    readFileSync(new URL("./vorton-theme-reference.source.json", import.meta.url), "utf8"),
  ) as { commit: string; sha256: string };
  const vorton = JSON.parse(referenceText) as {
    themes: Record<string, { roles: Record<string, string> }>;
  };

  type ColorField = keyof Theme["colors"];
  // Reference role to the built Vorteo color it governs. Roles Vorteo does not map (divider,
  // accentDecorative, focusRing, selection) and Vorteo-only fields (accentBright, surface4,
  // borderAccent) are not compared.
  const ROLE_FIELDS: ReadonlyArray<readonly [string, ColorField]> = [
    ["background", "surface0"],
    ["surfaceDeep", "surface1"],
    ["surface", "surface2"],
    ["surfaceRaised", "surface3"],
    ["text", "foreground"],
    ["textSecondary", "foregroundMuted"],
    ["textMuted", "foregroundExtraMuted"],
    ["border", "border"],
    ["accent", "accent"],
    ["accentForeground", "accentForeground"],
    ["success", "statusSuccess"],
    ["warning", "statusWarning"],
    ["danger", "statusDanger"],
    ["destructive", "destructive"],
  ];

  // One row per exception: theme, Vorteo field, Vorteo value, reference value, reason.
  type DriftException = readonly [
    theme: string,
    field: ColorField,
    vorteo: string,
    reference: string,
    reason: string,
  ];

  // Differences the owner decided to keep. The owner decided every colour matches in all
  // products, so the list is empty; declare a row here only for a future intentional difference.
  const DECIDED: readonly DriftException[] = [];

  function canonicalColor(value: string): string {
    const text = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
    if (hex && [3, 6, 8].includes(hex.length)) {
      const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
      const channels = [0, 2, 4].map((start) => Number.parseInt(full.slice(start, start + 2), 16));
      const alpha = full.length === 8 ? Number.parseInt(full.slice(6), 16) / 255 : 1;
      return [...channels, Math.round(alpha * 1000) / 1000].join(",");
    }
    const rgb = /^rgba?\((.+)\)$/.exec(text)?.[1];
    if (rgb) {
      const parts = rgb
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      const alpha = parts[3] ?? 1;
      return [...parts.slice(0, 3), Math.round(alpha * 1000) / 1000].join(",");
    }
    return text;
  }

  it("keeps the vendored reference byte for byte as synced", () => {
    expect(createHash("sha256").update(referenceText).digest("hex")).toBe(source.sha256);
  });

  it("matches Vorteo's palettes except declared exceptions", () => {
    const exceptions = new Map<string, { vorteo: string; reference: string }>();
    for (const [theme, field, vorteo, expected] of DECIDED) {
      exceptions.set(`${theme}.${field}`, { vorteo, reference: expected });
    }
    const problems: string[] = [];
    const rev = source.commit.slice(0, 7);
    for (const option of THEME_OPTIONS) {
      if (!("theme" in option)) continue;
      const roles = vorton.themes[option.name]?.roles;
      if (!roles) {
        problems.push(`${option.name} is missing from Vorton ${rev}.`);
        continue;
      }
      for (const [role, field] of ROLE_FIELDS) {
        const key = `${option.name}.${field}`;
        const vorteo = String(option.theme.colors[field]);
        const expected = roles[role];
        const exception = exceptions.get(key);
        exceptions.delete(key);
        const differs = canonicalColor(vorteo) !== canonicalColor(expected);
        const label = `${option.name}.${role} (Vorteo ${field})`;
        if (!exception) {
          if (differs) {
            problems.push(
              `${label} is ${vorteo}, Vorton ${rev} has ${expected}. Change the reference in Vorton and re-vendor, or declare an exception with a reason.`,
            );
          }
        } else if (!differs) {
          problems.push(`${label} now matches Vorton ${rev}; remove its stale exception.`);
        } else if (exception.vorteo !== vorteo || exception.reference !== expected) {
          problems.push(
            `${label} exception records ${exception.vorteo} against ${exception.reference}, but the values are now ${vorteo} against ${expected}. Review the exception.`,
          );
        }
      }
    }
    for (const key of exceptions.keys()) problems.push(`${key} exception matches no mapped role.`);
    expect(problems).toEqual([]);
  });
});
