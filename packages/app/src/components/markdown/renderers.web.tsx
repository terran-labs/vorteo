import { Text } from "react-native";
import { forwardRef, useMemo, type ComponentProps } from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFileLink } from "@/assistant-file-links";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { CAN_HOVER } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// Browser-owned hover underline, so a link that reflows out from under a resting cursor drops it.
// The library sets `textDecoration` inline, so the rule needs `!important` to outrank it.
const LINK_HOVER_CLASS = "vorteo-markdown-link";
const LINK_HOVER_STYLE_ID = "vorteo-markdown-link-hover";
const LINK_HOVER_CSS = `.${LINK_HOVER_CLASS}:hover { text-decoration: underline !important; }`;
function ensureLinkHoverRule() {
  if (!CAN_HOVER || typeof document === "undefined") return;
  if (document.getElementById(LINK_HOVER_STYLE_ID)) return;
  const styleElement = document.createElement("style");
  styleElement.id = LINK_HOVER_STYLE_ID;
  styleElement.textContent = LINK_HOVER_CSS;
  document.head.appendChild(styleElement);
}
ensureLinkHoverRule();

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const { tooltipPath, onHoverIn } = useFileLink(
    forgeUrl ? markdownLinkSource(forgeUrl) : markdownLinkSource(link.url, link.sourceType),
  );
  const tooltip = forgeUrl ?? tooltipPath;
  const anchorStyle = useMemo(
    () => ({ ...anchorProps.style, overflowWrap: "anywhere" as const }),
    [anchorProps.style],
  );
  const anchor = (
    <a
      {...anchorProps}
      href={forgeUrl ?? anchorProps.href}
      className={LINK_HOVER_CLASS}
      style={anchorStyle}
    >
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
