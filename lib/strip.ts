const DCP_MESSAGE_RE = /<dcp-message\b[^>]*>\s*|\s*<\/dcp-message>/gi;
const DCP_BLOCK_RE = /<dcp-compressed-block\b[^>]*>[\s\S]*?<\/dcp-compressed-block>/gi;
const DCP_REMINDER_RE = /<dcp-(?:system|turn|iteration)-reminder\b[^>]*>[\s\S]*?<\/dcp-(?:system|turn|iteration)-reminder>/gi;
const DCP_MANUAL_RE = /<dcp-manual-trigger\b[^>]*>[\s\S]*?<\/dcp-manual-trigger>/gi;

export function stripDcpMarkup(text: string): string {
  return text
    .replace(DCP_BLOCK_RE, "[DCP compressed context]")
    .replace(DCP_REMINDER_RE, "")
    .replace(DCP_MANUAL_RE, "")
    .replace(DCP_MESSAGE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripDcpMarkupFromContent(content: unknown): unknown {
  if (typeof content === "string") return stripDcpMarkup(content);
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return stripDcpMarkup(part);
      if (part && typeof part.text === "string") return { ...part, text: stripDcpMarkup(part.text) };
      if (part && typeof part.content === "string") return { ...part, content: stripDcpMarkup(part.content) };
      return part;
    });
  }
  return content;
}
