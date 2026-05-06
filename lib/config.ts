import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  logProviderPayloads: boolean;
  pruneNotification: "off" | "minimal" | "detailed";
  autoCompress: {
    enabled: boolean;
    thresholdPercent: number;
    hardLimitPercent: number;
    minContextPercent: number;
    nudgeFrequency: number;
    iterationNudgeThreshold: number;
    nudgeForce: "soft" | "strong";
    summaryBuffer: boolean;
    modelThresholds: Record<string, { thresholdPercent?: number; hardLimitPercent?: number; minContextPercent?: number }>;
  };
  commands: { enabled: boolean; protectedTools: string[] };
  manualMode: { enabled: boolean; automaticStrategies: boolean };
  turnProtection: { enabled: boolean; turns: number };
  experimental: { customPrompts: boolean; messageMode: boolean };
  protectedFilePatterns: string[];
  compress: {
    mode: "range" | "message";
    showCompression: boolean;
    summaryBuffer: boolean;
    protectedTools: string[];
    protectUserMessages: boolean;
  };
  strategies: {
    deduplication: { enabled: boolean; protectedTools: string[] };
    purgeErrors: { enabled: boolean; turns: number; protectedTools: string[] };
  };
}

const DEFAULT_PROTECTED_TOOLS = [
  // Pi built-in tools documented in /usr/lib/node_modules/@mariozechner/pi-coding-agent/docs/usage.md.
  "read", "bash", "edit", "write", "grep", "find", "ls",
];

export const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  logProviderPayloads: false,
  pruneNotification: "detailed",
  autoCompress: {
    enabled: true,
    thresholdPercent: 75,
    hardLimitPercent: 95,
    minContextPercent: 50,
    nudgeFrequency: 1,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    summaryBuffer: true,
    modelThresholds: {},
  },
  commands: { enabled: true, protectedTools: [] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  experimental: { customPrompts: false, messageMode: true },
  protectedFilePatterns: [],
  compress: {
    mode: "range",
    showCompression: true,
    summaryBuffer: true,
    protectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    protectUserMessages: true,
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function merge<T extends Record<string, any>>(base: T, override: unknown): T {
  if (!isObject(override)) return base;
  const out: any = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else out[key] = value;
  }
  return out;
}

function readJsonc(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return parse(readFileSync(path, "utf8"));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))];
}

function clampPercent(value: unknown, fallback: number, min = 1, max = 100): number {
  return Math.max(min, Math.min(max, Number(value) || fallback));
}

function clampConfig(config: DcpConfig): DcpConfig {
  config.pruneNotification = ["off", "minimal", "detailed"].includes(config.pruneNotification) ? config.pruneNotification : "detailed";
  config.autoCompress.thresholdPercent = clampPercent(config.autoCompress.thresholdPercent, 75, 1, 99);
  config.autoCompress.hardLimitPercent = Math.max(config.autoCompress.thresholdPercent + 1, clampPercent(config.autoCompress.hardLimitPercent, 95, 2, 100));
  config.autoCompress.minContextPercent = clampPercent(config.autoCompress.minContextPercent, 50, 1, config.autoCompress.thresholdPercent);
  config.autoCompress.nudgeFrequency = Math.max(1, Math.floor(Number(config.autoCompress.nudgeFrequency) || 1));
  config.autoCompress.iterationNudgeThreshold = Math.max(1, Math.floor(Number(config.autoCompress.iterationNudgeThreshold) || 15));
  config.autoCompress.nudgeForce = config.autoCompress.nudgeForce === "strong" ? "strong" : "soft";
  config.compress.mode = config.compress.mode === "message" ? "message" : "range";
  config.commands.protectedTools = unique([...DEFAULT_PROTECTED_TOOLS, ...config.commands.protectedTools]);
  config.compress.protectedTools = unique([...config.compress.protectedTools]);
  config.strategies.deduplication.protectedTools = unique([...DEFAULT_PROTECTED_TOOLS, ...config.strategies.deduplication.protectedTools]);
  config.strategies.purgeErrors.protectedTools = unique([...DEFAULT_PROTECTED_TOOLS, ...config.strategies.purgeErrors.protectedTools]);
  config.strategies.purgeErrors.turns = Math.max(1, Math.floor(Number(config.strategies.purgeErrors.turns) || 4));
  config.turnProtection.turns = Math.max(1, Math.floor(Number(config.turnProtection.turns) || 4));
  return config;
}

export function loadConfig(cwd: string): { config: DcpConfig; paths: string[] } {
  const paths = [
    join(homedir(), ".pi", "agent", "dcp", "config.jsonc"),
    join(cwd, "Config", "dcp.jsonc"),
    join(cwd, ".pi", "dcp", "config.jsonc"),
  ];
  let config = structuredClone(DEFAULT_CONFIG);
  for (const path of paths) {
    const value = readJsonc(path);
    if (value) config = merge(config, value);
  }
  return { config: clampConfig(config), paths };
}
