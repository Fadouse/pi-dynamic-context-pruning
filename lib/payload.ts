import { createHash } from "node:crypto";
import type { DcpBlock, DcpMessageRef, DcpState } from "./state.js";
import { approxTokens, formatMessageId, pushWarning } from "./state.js";

export interface PayloadMessage {
  role?: string;
  content?: unknown;
  name?: string;
  toolName?: string;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface PreparedPayload {
  changed: boolean;
  messages: DcpMessageRef[];
  activeBlocks: DcpBlock[];
}

/** Stable content hash lets message IDs survive small provider-order changes across turns. */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Convert OpenAI/Anthropic-style string or content-part arrays to text for hashing and token estimates. */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        if (typeof part?.name === "string" || typeof part?.toolName === "string") return JSON.stringify(part);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function wrapText(id: string, role: string, text: string): string {
  if (text.includes(`<dcp-message id=\"${id}\"`)) return text;
  return `<dcp-message id=\"${id}\" role=\"${role}\">\n${text}\n</dcp-message>`;
}

function withWrappedContent(content: unknown, id: string, role: string): unknown {
  if (typeof content === "string") return wrapText(id, role, content);
  if (Array.isArray(content)) {
    const out = structuredClone(content) as any[];
    const textIndex = out.findIndex((p) => typeof p?.text === "string");
    if (textIndex >= 0) out[textIndex] = { ...out[textIndex], text: wrapText(id, role, out[textIndex].text) };
    else out.unshift({ type: "text", text: `<dcp-message id=\"${id}\" role=\"${role}\"></dcp-message>` });
    return out;
  }
  return content;
}

function makeBlockMessage(block: DcpBlock): PayloadMessage {
  return {
    role: "user",
    content: `<dcp-compressed-block id=\"${block.id}\" n=\"${block.displayId}\" source=\"${block.source}\" topic=\"${escapeXml(block.topic)}\" range=\"${block.startId}-${block.endId}\">\n${block.summary}\n</dcp-compressed-block>`,
    timestamp: Date.now(),
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/\"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findExistingByHash(state: DcpState, hash: string, index: number, usedIds: Set<string>): DcpMessageRef | undefined {
  return state.messages.find((m) => !usedIds.has(m.id) && m.hash === hash && Math.abs(m.index - index) <= 1) ?? state.messages.find((m) => !usedIds.has(m.id) && m.hash === hash);
}

function detectToolName(message: PayloadMessage, text: string): string | undefined {
  const direct = message.name ?? message.toolName ?? (message as any).tool_name;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const match = text.match(/(?:tool|name|tool_name)["'`\s:=]+([a-zA-Z0-9_.-]+)/i);
  return match?.[1]?.toLowerCase();
}

function detectFilePath(text: string): string | undefined {
  const match = text.match(/(?:filePath|path|file)["'`\s:=]+([^"'`\s,}]+)/i);
  return match?.[1];
}

function isErrorLike(text: string): boolean {
  return /\b(error|exception|traceback|failed|failure|exit code [1-9]|isError["'`\s:=]+true)\b/i.test(text);
}

/** Assign or reuse m0001-style IDs for the current uncompressed provider message list. */
export function syncMessageRefs(state: DcpState, rawMessages: PayloadMessage[]): DcpMessageRef[] {
  const refs: DcpMessageRef[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < rawMessages.length; index++) {
    const message = rawMessages[index];
    const role = String(message.role ?? "unknown");
    const text = textFromContent(message.content);
    const hash = hashText(`${role}\n${text}`);
    const existing = findExistingByHash(state, hash, index, usedIds);
    const ref: DcpMessageRef = existing
      ? { ...existing, index, role, tokensApprox: approxTokens(text), turn: state.runtime.turn }
      : { id: formatMessageId(state.nextMessageNumber++), index, role, hash, tokensApprox: approxTokens(text), turn: state.runtime.turn };
    ref.toolName = detectToolName(message, text);
    ref.filePath = detectFilePath(text);
    ref.errorLike = isErrorLike(text);
    usedIds.add(ref.id);
    refs.push(ref);
  }
  state.messages = refs;
  return refs;
}

export function blockRange(refs: DcpMessageRef[], block: DcpBlock): { start: number; end: number } | undefined {
  const start = refs.find((r) => r.id === block.startId)?.index;
  const end = refs.find((r) => r.id === block.endId)?.index;
  if (start === undefined || end === undefined || start > end) return undefined;
  return { start, end };
}

function validateActiveBlocks(state: DcpState, refs: DcpMessageRef[]) {
  const ranges: { id: string; start: number; end: number }[] = [];
  for (const block of state.blocks.filter((b) => b.active)) {
    const range = blockRange(refs, block);
    if (!range) {
      pushWarning(state, `Active DCP block ${block.id} (${block.startId}-${block.endId}) is stale for the current provider payload.`);
      continue;
    }
    if (ranges.some((r) => !(range.end < r.start || range.start > r.end))) pushWarning(state, `Active DCP block ${block.id} overlaps another active block in the current payload.`);
    ranges.push({ id: block.id, ...range });
  }
}

/** Build the virtual DCP context: replace active ranges, wrap visible messages, append nudges. */
export function preparePayload(payload: any, state: DcpState, nudge?: string): PreparedPayload {
  if (!payload || !Array.isArray(payload.messages)) return { changed: false, messages: [], activeBlocks: [] };

  const original = payload.messages as PayloadMessage[];
  const refs = syncMessageRefs(state, original);
  validateActiveBlocks(state, refs);
  const activeBlocks = state.blocks.filter((b) => b.active);
  const replacements = activeBlocks
    .map((block) => ({ block, range: blockRange(refs, block) }))
    .filter((x): x is { block: DcpBlock; range: { start: number; end: number } } => !!x.range)
    .sort((a, b) => a.range.start - b.range.start);

  const output: PayloadMessage[] = [];
  for (let i = 0; i < original.length; i++) {
    const replacement = replacements.find((r) => r.range.start === i);
    if (replacement) {
      output.push(makeBlockMessage(replacement.block));
      i = replacement.range.end;
      continue;
    }
    const ref = refs[i];
    output.push({ ...structuredClone(original[i]), content: withWrappedContent(original[i].content, ref.id, ref.role) });
  }

  if (nudge) output.push({ role: "user", content: nudge });
  payload.messages = output;
  return { changed: true, messages: refs, activeBlocks };
}

export function visibleMessageList(refs: DcpMessageRef[]): string {
  return refs.map((m) => `${m.id} ${m.role}${m.toolName ? `:${m.toolName}` : ""} ~${m.tokensApprox}t`).join("\n");
}
