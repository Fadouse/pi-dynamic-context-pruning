import type { DcpConfig } from "./config.js";
import { PromptStore } from "./prompts.js";
import type { DcpState } from "./state.js";

export interface UsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface NudgeDecision {
  text?: string;
  kind?: "context" | "turn" | "iteration";
}

export function effectiveThresholds(config: DcpConfig, modelKey?: string) {
  const override = modelKey ? config.autoCompress.modelThresholds[modelKey] : undefined;
  return {
    thresholdPercent: override?.thresholdPercent ?? config.autoCompress.thresholdPercent,
    hardLimitPercent: override?.hardLimitPercent ?? config.autoCompress.hardLimitPercent,
    minContextPercent: override?.minContextPercent ?? config.autoCompress.minContextPercent,
  };
}

export function chooseNudge(state: DcpState, config: DcpConfig, prompts: PromptStore, usage: UsageInfo | undefined, modelKey?: string): NudgeDecision {
  if (!config.autoCompress.enabled || state.runtime.manualMode || state.runtime.autoEnabled === false) return {};
  if (!usage || usage.tokens == null || usage.percent == null) return {};
  const thresholds = effectiveThresholds(config, modelKey);
  const threshold = state.runtime.thresholdPercent ?? thresholds.thresholdPercent;
  const elapsedTurns = state.runtime.turn - state.runtime.lastNudgeTurn;
  if (usage.percent >= threshold && elapsedTurns >= config.autoCompress.nudgeFrequency) {
    return { kind: "context", text: buildContextNudge(config, prompts, usage, thresholds.hardLimitPercent, threshold) };
  }
  if (usage.percent >= thresholds.minContextPercent && elapsedTurns >= config.autoCompress.iterationNudgeThreshold) {
    return { kind: "iteration", text: prompts.get("iteration-nudge") };
  }
  if (usage.percent >= thresholds.minContextPercent && elapsedTurns >= 1 && config.autoCompress.nudgeForce === "strong") {
    return { kind: "turn", text: prompts.get("turn-nudge") };
  }
  return {};
}

export function buildContextNudge(config: DcpConfig, prompts: PromptStore, usage: UsageInfo, hard: number, threshold: number): string {
  const percent = usage.percent == null ? "unknown" : `${usage.percent.toFixed(1)}%`;
  const tokens = usage.tokens == null ? "unknown" : usage.tokens.toLocaleString();
  const window = usage.contextWindow.toLocaleString();
  const force = usage.percent != null && usage.percent >= hard;
  return prompts.render("context-limit-nudge", {
    severity: force ? "hard" : "soft",
    tokens,
    contextWindow: window,
    percent,
    threshold,
    hard,
    hardMessage: force ? "You are at or past the hard DCP limit. Before continuing normal work, call the compress tool on closed or low-priority context." : "",
  });
}

export function systemPromptExtension(prompts: PromptStore): string {
  return `\n\n${prompts.get("system")}\n`;
}
