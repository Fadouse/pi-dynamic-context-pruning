import type { DcpMessageRef } from "./state.js";

export function globMatch(pattern: string, value: string | undefined): boolean {
  if (!value) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

export function matchesAny(patterns: string[], value: string | undefined): boolean {
  return patterns.some((pattern) => globMatch(pattern, value));
}

export function isToolProtected(message: DcpMessageRef, protectedTools: string[]): boolean {
  return !!message.toolName && matchesAny(protectedTools, message.toolName);
}

export function isFileProtected(message: DcpMessageRef, protectedFilePatterns: string[]): boolean {
  return !!message.filePath && matchesAny(protectedFilePatterns, message.filePath);
}
