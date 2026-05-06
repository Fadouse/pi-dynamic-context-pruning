import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DcpMessageRef {
  id: string;
  index: number;
  role: string;
  hash: string;
  tokensApprox: number;
  toolName?: string;
  filePath?: string;
  errorLike?: boolean;
  turn: number;
}

export interface DcpBlock {
  id: string;
  displayId: number;
  topic: string;
  startId: string;
  endId: string;
  summary: string;
  createdAt: number;
  compressedTokensApprox: number;
  summaryTokensApprox: number;
  active: boolean;
  source: "compress" | "sweep" | "deduplication" | "purgeErrors";
  userDecompressed?: boolean;
}

export interface DcpState {
  version: 1;
  nextMessageNumber: number;
  nextBlockNumber: number;
  messages: DcpMessageRef[];
  blocks: DcpBlock[];
  warnings: string[];
  stats: {
    nudges: number;
    turnNudges: number;
    iterationNudges: number;
    compressions: number;
    decompressions: number;
    recompressions: number;
    sweptMessages: number;
    deduplicatedMessages: number;
    purgedErrorMessages: number;
    totalPruneTokens: number;
    totalSummaryTokens: number;
    compressionDurationsMs: number[];
  };
  runtime: {
    manualMode: boolean;
    autoEnabled?: boolean;
    thresholdPercent?: number;
    lastNudgeTurn: number;
    turn: number;
  };
}

export function createEmptyState(): DcpState {
  return {
    version: 1,
    nextMessageNumber: 1,
    nextBlockNumber: 1,
    messages: [],
    blocks: [],
    warnings: [],
    stats: {
      nudges: 0,
      turnNudges: 0,
      iterationNudges: 0,
      compressions: 0,
      decompressions: 0,
      recompressions: 0,
      sweptMessages: 0,
      deduplicatedMessages: 0,
      purgedErrorMessages: 0,
      totalPruneTokens: 0,
      totalSummaryTokens: 0,
      compressionDurationsMs: [],
    },
    runtime: { manualMode: false, lastNudgeTurn: 0, turn: 0 },
  };
}

export function statePath(cwd: string): string {
  return join(cwd, ".pi", "dcp", "state.json");
}

export function loadState(cwd: string): { state: DcpState; path: string } {
  const path = statePath(cwd);
  if (!existsSync(path)) return { state: createEmptyState(), path };
  try {
    const loaded = JSON.parse(readFileSync(path, "utf8")) as Partial<DcpState>;
    const empty = createEmptyState();
    return {
      state: {
        ...empty,
        ...loaded,
        stats: { ...empty.stats, ...(loaded.stats ?? {}) },
        runtime: { ...empty.runtime, ...(loaded.runtime ?? {}) },
        warnings: loaded.warnings ?? [],
      },
      path,
    };
  } catch {
    return { state: createEmptyState(), path };
  }
}

export function saveState(path: string, state: DcpState) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

export function formatMessageId(n: number): string {
  return `m${String(n).padStart(4, "0")}`;
}

export function formatBlockId(n: number): string {
  return `b${n}`;
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function resolveBlock(state: DcpState, arg: string): DcpBlock | undefined {
  const trimmed = arg.trim().toLowerCase();
  const byId = state.blocks.find((b) => b.id.toLowerCase() === trimmed);
  if (byId) return byId;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return state.blocks.find((b) => b.displayId === n);
  return undefined;
}

export function pushWarning(state: DcpState, warning: string) {
  if (!state.warnings.includes(warning)) state.warnings.push(warning);
  state.warnings = state.warnings.slice(-20);
}

export function recordBlockStats(state: DcpState, block: DcpBlock) {
  state.stats.totalPruneTokens += block.compressedTokensApprox;
  state.stats.totalSummaryTokens += block.summaryTokensApprox;
}
