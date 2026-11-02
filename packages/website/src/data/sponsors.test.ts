import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPONSORS, sponsorHref } from "./sponsors";

const WEBSITE_PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));
describe("sponsorHref", () => {
  it("tags the link with the placement it is shown in", () => {
    const sponsor = {
      name: "Acme",
      url: "https://acme.dev",
      logo: { onDark: "", onLight: "" },
      description: "",
    };

    expect(sponsorHref(sponsor, "website")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=website&utm_campaign=sponsor",
    );
    expect(sponsorHref(sponsor, "x")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=x&utm_campaign=sponsor",
    );
    expect(sponsorHref(sponsor, "readme")).toBe(
      "https://acme.dev/?utm_source=paseo&utm_medium=readme&utm_campaign=sponsor",
    );
  });
});

describe("SPONSORS", () => {
  it.each(SPONSORS)("ships both logo inks for $name", (sponsor) => {
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onDark}`)).toBe(true);
    expect(existsSync(`${WEBSITE_PUBLIC}${sponsor.logo.onLight}`)).toBe(true);
  });
});
