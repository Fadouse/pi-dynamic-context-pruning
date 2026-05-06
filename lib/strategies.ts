import type { DcpConfig } from "./config.js";
import { isFileProtected, isToolProtected } from "./match.js";
import type { DcpBlock, DcpMessageRef, DcpState } from "./state.js";
import { approxTokens, formatBlockId, recordBlockStats } from "./state.js";

function covered(state: DcpState, msg: DcpMessageRef): boolean {
  return state.blocks.some((block) => block.active && inBlock(state, block, msg));
}

function inBlock(state: DcpState, block: DcpBlock, msg: DcpMessageRef): boolean {
  const start = state.messages.find((m) => m.id === block.startId)?.index;
  const end = state.messages.find((m) => m.id === block.endId)?.index;
  return start !== undefined && end !== undefined && msg.index >= start && msg.index <= end;
}

function createSingleMessageBlock(state: DcpState, msg: DcpMessageRef, source: DcpBlock["source"], topic: string, summary: string): DcpBlock {
  const block: DcpBlock = {
    id: formatBlockId(state.nextBlockNumber++),
    displayId: state.blocks.length + 1,
    topic,
    startId: msg.id,
    endId: msg.id,
    summary,
    createdAt: Date.now(),
    compressedTokensApprox: msg.tokensApprox,
    summaryTokensApprox: approxTokens(summary),
    active: true,
    source,
  };
  state.blocks.push(block);
  recordBlockStats(state, block);
  return block;
}

export function applyAutomaticStrategies(state: DcpState, config: DcpConfig): string[] {
  if (state.runtime.manualMode && !config.manualMode.automaticStrategies) return [];
  const created: string[] = [];
  created.push(...deduplicate(state, config));
  created.push(...purgeErrors(state, config));
  return created;
}

function deduplicate(state: DcpState, config: DcpConfig): string[] {
  if (!config.strategies.deduplication.enabled) return [];
  const seen = new Map<string, DcpMessageRef>();
  const lines: string[] = [];
  for (const msg of state.messages) {
    if (covered(state, msg) || isToolProtected(msg, config.strategies.deduplication.protectedTools) || isFileProtected(msg, config.protectedFilePatterns)) continue;
    if (!(msg.role === "tool" || msg.role === "function" || msg.toolName)) continue;
    const key = `${msg.role}:${msg.toolName ?? "unknown"}:${msg.hash}`;
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, msg);
      continue;
    }
    const summary = `Duplicate tool/result message ${msg.id} hidden by DCP deduplication. It duplicates earlier message ${previous.id}. The full original content remains in the Pi session and can be restored with /dcp decompress.`;
    const block = createSingleMessageBlock(state, msg, "deduplication", "Duplicate tool output", summary);
    state.stats.deduplicatedMessages++;
    state.stats.compressions++;
    lines.push(`${block.id} ${msg.id}`);
  }
  return lines;
}

function purgeErrors(state: DcpState, config: DcpConfig): string[] {
  if (!config.strategies.purgeErrors.enabled) return [];
  const lines: string[] = [];
  for (const msg of state.messages) {
    if (!msg.errorLike || covered(state, msg)) continue;
    if (state.runtime.turn - msg.turn < config.strategies.purgeErrors.turns) continue;
    if (config.turnProtection.enabled && state.runtime.turn - msg.turn < config.turnProtection.turns) continue;
    if (isToolProtected(msg, config.strategies.purgeErrors.protectedTools) || isFileProtected(msg, config.protectedFilePatterns)) continue;
    const summary = `Errored tool/result message ${msg.id} hidden by DCP purgeErrors after ${config.strategies.purgeErrors.turns} turn(s). The failure is preserved as metadata: role=${msg.role}${msg.toolName ? `, tool=${msg.toolName}` : ""}. Restore with /dcp decompress if the full error output is needed.`;
    const block = createSingleMessageBlock(state, msg, "purgeErrors", "Purged errored output", summary);
    state.stats.purgedErrorMessages++;
    state.stats.compressions++;
    lines.push(`${block.id} ${msg.id}`);
  }
  return lines;
}
