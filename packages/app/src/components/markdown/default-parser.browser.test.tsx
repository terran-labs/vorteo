import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { expect, test } from "vitest";
import { prepareMarkdownSource } from "./source";

test("default Markdown renderer preserves formatting and rejects active markup", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <EnrichedMarkdownText
          markdown={prepareMarkdownSource(
            "# Heading\n\n**Strong** and *emphasis*.\n\n- Item one\n- Item two\n\n`code`\n\n[safe](https://example.com)\n\n[unsafe](javascript:alert(1))\n\n<script>window.syntheticExecuted = true</script>",
          ).render()}
        />,
      );
    });
    await expect.poll(() => container.textContent).toContain("Heading");
    expect(container.textContent).toContain("Strong and emphasis.");
    expect(container.textContent).toContain("Item one");
    expect(container.textContent).toContain("Item two");
    expect(container.textContent).toContain("code");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.textContent).toContain("[unsafe](javascript:alert(1))");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
