import type { DcpConfig } from "./config.js";
import { isFileProtected, isToolProtected } from "./match.js";
import { PromptStore } from "./prompts.js";
import type { DcpBlock, DcpMessageRef, DcpState } from "./state.js";
import { approxTokens, formatBlockId, recordBlockStats, resolveBlock } from "./state.js";

export function help(): string {
  return `DCP Commands\n\n/dcp help                 Show this help\n/dcp context              Show current context usage, token categories, and message ids\n/dcp stats                Show DCP statistics and active blocks\n/dcp compress [focus]     Ask the model to call the compress tool\n/dcp decompress <n|bId>   Restore a compressed block in future context\n/dcp recompress <n|bId>   Re-enable a decompressed block\n/dcp manual [on|off]      Toggle manual mode; manual mode disables auto nudges\n/dcp auto [on|off]        Enable/disable auto DCP nudges for this session\n/dcp threshold <percent>  Set auto nudge threshold for this session\n/dcp sweep [n]            Compress tool/result messages since last user message, or last n tool/result messages`;
}

export function contextReport(state: DcpState, usageLine: string): string {
  const byRole = new Map<string, { count: number; tokens: number }>();
  for (const msg of state.messages) {
    const entry = byRole.get(msg.role) ?? { count: 0, tokens: 0 };
    entry.count++;
    entry.tokens += msg.tokensApprox;
    byRole.set(msg.role, entry);
  }
  const roleLines = [...byRole.entries()].map(([role, value]) => `- ${role}: ${value.count} message(s), ~${value.tokens}t`).join("\n");
  const activeSaved = state.blocks.filter((b) => b.active).reduce((sum, b) => sum + Math.max(0, b.compressedTokensApprox - b.summaryTokensApprox), 0);
  return ["DCP Context", usageLine, `Estimated active savings: ~${activeSaved}t`, "", "Token categories:", roleLines || "No messages yet.", "", "Current message ids:", state.messages.map((m) => `${m.id} ${m.role}${m.toolName ? `:${m.toolName}` : ""} ~${m.tokensApprox}t turn=${m.turn}`).join("\n") || "No message ids yet. Send one model request first."].join("\n");
}

export function stats(state: DcpState, config: DcpConfig): string {
  const active = state.blocks.filter((b) => b.active);
  const inactive = state.blocks.filter((b) => !b.active);
  const threshold = state.runtime.thresholdPercent ?? config.autoCompress.thresholdPercent;
  const auto = state.runtime.autoEnabled === false ? "off" : config.autoCompress.enabled && !state.runtime.manualMode ? "on" : "off";
  const avgMs = state.stats.compressionDurationsMs.length ? Math.round(state.stats.compressionDurationsMs.reduce((a, b) => a + b, 0) / state.stats.compressionDurationsMs.length) : 0;
  const blockLines = state.blocks.map((b) => `${b.active ? "✓" : "○"} ${b.displayId}. ${b.id} ${b.startId}-${b.endId} ${b.topic} source=${b.source} (~${b.compressedTokensApprox}t → ~${b.summaryTokensApprox}t)`).join("\n");
  const warningLines = state.warnings.length ? `\n\nWarnings:\n${state.warnings.map((w) => `- ${w}`).join("\n")}` : "";
  return `DCP Stats\nAuto: ${auto}\nManual mode: ${state.runtime.manualMode ? "on" : "off"}\nThreshold: ${threshold}%\nHard limit: ${config.autoCompress.hardLimitPercent}%\nNudges: ${state.stats.nudges} (turn ${state.stats.turnNudges}, iteration ${state.stats.iterationNudges})\nCompressions: ${state.stats.compressions}\nDecompressions: ${state.stats.decompressions}\nRecompressions: ${state.stats.recompressions}\nSwept messages: ${state.stats.sweptMessages}\nDeduplicated messages: ${state.stats.deduplicatedMessages}\nPurged error messages: ${state.stats.purgedErrorMessages}\nTotal pruned: ~${state.stats.totalPruneTokens}t\nTotal summaries: ~${state.stats.totalSummaryTokens}t\nAverage compression handler time: ${avgMs}ms\nActive blocks: ${active.length}\nInactive blocks: ${inactive.length}\n\n${blockLines || "No compression blocks."}${warningLines}`;
}

export function decompress(state: DcpState, arg: string): string {
  if (!arg.trim()) return availableBlocks(state, true);
  const block = resolveBlock(state, arg);
  if (!block) return `No compression block found for ${arg}.\n\n${availableBlocks(state, true)}`;
  if (!block.active) return `${block.id} is already decompressed.`;
  block.active = false;
  block.userDecompressed = true;
  state.stats.decompressions++;
  return `DCP decompressed ${block.displayId}. ${block.id} (${block.topic}). It will be restored in future model context.`;
}

export function recompress(state: DcpState, arg: string): string {
  if (!arg.trim()) return availableBlocks(state, false);
  const block = resolveBlock(state, arg);
  if (!block) return `No compression block found for ${arg}.\n\n${availableBlocks(state, false)}`;
  if (block.active) return `${block.id} is already compressed.`;
  block.active = true;
  block.userDecompressed = false;
  state.stats.recompressions++;
  return `DCP recompressed ${block.displayId}. ${block.id} (${block.topic}).`;
}

export function sweep(state: DcpState, config: DcpConfig, arg: string): string {
  const count = arg.trim() ? Number(arg.trim()) : undefined;
  if (count !== undefined && (!Number.isFinite(count) || count < 1)) return "Usage: /dcp sweep [positive-number]";
  const candidates = selectSweepCandidates(state, config, count);
  if (!candidates.length) return "No unswept, unprotected tool/result messages are available to sweep.";
  const runs = contiguousRuns(candidates);
  const lines: string[] = [];
  for (const run of runs) {
    const start = run[0];
    const end = run[run.length - 1];
    const compressedTokensApprox = run.reduce((sum, msg) => sum + msg.tokensApprox, 0);
    const summary = `DCP sweep compressed ${run.length} tool/result message(s) (${start.id}-${end.id}, ~${compressedTokensApprox} tokens) out of future model context. Original Pi session entries are preserved; use /dcp decompress to restore details.`;
    const block: DcpBlock = { id: formatBlockId(state.nextBlockNumber++), displayId: state.blocks.length + 1, topic: "Swept tool output", startId: start.id, endId: end.id, summary, createdAt: Date.now(), compressedTokensApprox, summaryTokensApprox: approxTokens(summary), active: true, source: "sweep" };
    state.blocks.push(block);
    recordBlockStats(state, block);
    state.stats.compressions++;
    state.stats.sweptMessages += run.length;
    lines.push(`${block.displayId}. ${block.id} ${block.startId}-${block.endId}: swept ${run.length} message(s), ~${block.compressedTokensApprox}t → ~${block.summaryTokensApprox}t`);
  }
  return `DCP sweep compressed ${candidates.length} tool/result message(s):\n${lines.join("\n")}`;
}

function availableBlocks(state: DcpState, active: boolean): string {
  const blocks = state.blocks.filter((b) => b.active === active);
  if (!blocks.length) return active ? "No active compressions are available to decompress." : "No decompressed blocks are available to recompress.";
  return blocks.map((b) => `${b.displayId}. ${b.id} ${b.startId}-${b.endId} ${b.topic} (~${b.compressedTokensApprox}t)`).join("\n");
}

export function compressPrompt(prompts: PromptStore, focus: string): string {
  return prompts.render("manual-compress", { focus: focus ? ` with focus: ${focus}` : "" });
}

function selectSweepCandidates(state: DcpState, config: DcpConfig, count: number | undefined): DcpMessageRef[] {
  const unsweptTools = state.messages.filter((msg) => isToolLike(msg) && !isCoveredByActiveBlock(state, msg) && !isToolProtected(msg, config.commands.protectedTools) && !isFileProtected(msg, config.protectedFilePatterns));
  if (count !== undefined) return unsweptTools.slice(-count);
  const lastUserIndex = Math.max(-1, ...state.messages.filter((msg) => msg.role === "user").map((msg) => msg.index));
  const sinceLastUser = unsweptTools.filter((msg) => msg.index > lastUserIndex);
  return sinceLastUser.length ? sinceLastUser : unsweptTools;
}

function isToolLike(msg: DcpMessageRef): boolean {
  const role = msg.role.toLowerCase();
  return role === "tool" || role === "function" || role === "tool_result" || role === "toolresult" || !!msg.toolName;
}

function isCoveredByActiveBlock(state: DcpState, msg: DcpMessageRef): boolean {
  return state.blocks.some((block) => {
    if (!block.active) return false;
    const start = state.messages.find((candidate) => candidate.id === block.startId)?.index;
    const end = state.messages.find((candidate) => candidate.id === block.endId)?.index;
    return start !== undefined && end !== undefined && msg.index >= start && msg.index <= end;
  });
}

function contiguousRuns(messages: DcpMessageRef[]): DcpMessageRef[][] {
  const sorted = [...messages].sort((a, b) => a.index - b.index);
  const runs: DcpMessageRef[][] = [];
  for (const msg of sorted) {
    const lastRun = runs[runs.length - 1];
    const last = lastRun?.[lastRun.length - 1];
    if (lastRun && last && msg.index === last.index + 1) lastRun.push(msg);
    else runs.push([msg]);
  }
  return runs;
}
