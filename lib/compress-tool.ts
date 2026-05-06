import { Type } from "typebox";
import type { DcpConfig } from "./config.js";
import { isFileProtected, isToolProtected } from "./match.js";
import type { DcpState } from "./state.js";
import { approxTokens, formatBlockId, recordBlockStats, type DcpBlock, type DcpMessageRef } from "./state.js";

export const CompressToolParameters = Type.Object({
  topic: Type.String({ description: "Short label, 3-5 words, for the compressed context." }),
  content: Type.Array(
    Type.Object({
      startId: Type.String({ description: "First dcp-message id in range, e.g. m0003." }),
      endId: Type.String({ description: "Last dcp-message id in range, e.g. m0012." }),
      summary: Type.String({ description: "Complete technical summary replacing every message in the range." }),
    }),
    { description: "One or more ranges to compress." },
  ),
});

export interface CompressArgs {
  topic: string;
  content: { startId: string; endId: string; summary: string }[];
}

function activeRangeOverlap(state: DcpState, start: DcpMessageRef, end: DcpMessageRef): DcpBlock | undefined {
  return state.blocks.find((block) => {
    if (!block.active) return false;
    const blockStart = state.messages.find((m) => m.id === block.startId)?.index;
    const blockEnd = state.messages.find((m) => m.id === block.endId)?.index;
    return blockStart !== undefined && blockEnd !== undefined && !(end.index < blockStart || start.index > blockEnd);
  });
}

function fence(text: string | undefined): string {
  const value = text?.trim() || "(no text captured)";
  return value.includes("```") ? value.replace(/```/g, "`\u200b``") : value;
}

/**
 * OpenCode DCP's compress.protectedTools does not mean "forbid compressing
 * these messages". It means their outputs are environment-managed and appended
 * to the stored summary when a selected compression range contains them.
 */
function appendProtectedContent(summary: string, messages: DcpMessageRef[], config: DcpConfig): string {
  const sections: string[] = [];

  if (config.compress.protectUserMessages) {
    const users = messages.filter((m) => m.role === "user");
    if (users.length) {
      sections.push(`\n\nThe following user messages were preserved verbatim during compression:\n${users.map((m) => `\n### ${m.id} user\n${fence(m.text)}`).join("\n")}`);
    }
  }

  const protectedMessages = messages.filter((m) => isToolProtected(m, config.compress.protectedTools) || isFileProtected(m, config.protectedFilePatterns));
  if (protectedMessages.length) {
    sections.push(`\n\nThe following protected tool/file outputs were used in this conversation as well and are preserved verbatim:\n${protectedMessages.map((m) => `\n### ${m.id} ${m.toolName ? `tool: ${m.toolName}` : m.role}${m.filePath ? ` (${m.filePath})` : ""}\n${fence(m.text)}`).join("\n")}`);
  }

  return sections.length ? `${summary}${sections.join("")}` : summary;
}

export function applyCompression(state: DcpState, args: CompressArgs, config: DcpConfig): { text: string; blocks: DcpBlock[] } {
  const started = Date.now();
  const blocks: DcpBlock[] = [];
  const lines: string[] = [];
  const byId = new Map(state.messages.map((m) => [m.id, m]));

  for (const item of args.content ?? []) {
    const start = byId.get(item.startId);
    const end = byId.get(item.endId);
    if (!start || !end) throw new Error(`Unknown DCP range: ${item.startId}-${item.endId}`);
    if (start.index > end.index) throw new Error(`Invalid DCP range: ${item.startId} is after ${item.endId}`);
    const overlap = activeRangeOverlap(state, start, end);
    if (overlap) throw new Error(`DCP range ${item.startId}-${item.endId} overlaps active block ${overlap.id}. Decompress or choose a non-overlapping range.`);

    const rangeMessages = state.messages.filter((m) => m.index >= start.index && m.index <= end.index);
    const compressedTokensApprox = rangeMessages.reduce((sum, m) => sum + m.tokensApprox, 0);
    const summary = appendProtectedContent(item.summary, rangeMessages, config);
    const block: DcpBlock = {
      id: formatBlockId(state.nextBlockNumber++),
      displayId: state.blocks.length + blocks.length + 1,
      topic: args.topic || "Compressed Context",
      startId: item.startId,
      endId: item.endId,
      summary,
      createdAt: Date.now(),
      compressedTokensApprox,
      summaryTokensApprox: approxTokens(summary),
      active: true,
      source: "compress",
    };
    blocks.push(block);
    recordBlockStats(state, block);
    lines.push(`${block.displayId}. ${block.id} ${block.startId}-${block.endId}: ~${block.compressedTokensApprox}t → ~${block.summaryTokensApprox}t (${block.topic})`);
  }

  state.blocks.push(...blocks);
  state.stats.compressions += blocks.length;
  state.stats.compressionDurationsMs.push(Date.now() - started);
  state.stats.compressionDurationsMs = state.stats.compressionDurationsMs.slice(-100);

  return {
    text: blocks.length ? `DCP compressed ${blocks.length} range(s):\n${lines.join("\n")}` : "No DCP ranges were compressed.",
    blocks,
  };
}
