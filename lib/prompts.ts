import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DcpConfig } from "./config.js";

export type PromptKey = "system" | "context-limit-nudge" | "turn-nudge" | "iteration-nudge" | "manual-compress";

const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  system: `## Dynamic Context Pruning (DCP)\n\nThis session has a DCP compression tool. Messages visible to you may be wrapped as <dcp-message id="m0001">...</dcp-message>.\nWhen context is high or the user asks /dcp compress, call the compress tool with ranges of old, closed, or low-priority messages and high-fidelity summaries.\nDo not compress current active work unless necessary. If compression would lose important details, delay briefly, but complete compression before the hard context limit.\nUse startId/endId from the dcp-message ids. Compressed blocks can later be restored with /dcp decompress.`,
  "context-limit-nudge": `<dcp-system-reminder severity="{{severity}}">\nCurrent context usage: {{tokens}} / {{contextWindow}} tokens ({{percent}}).\nDCP threshold: {{threshold}}%. Hard limit: {{hard}}%.\n\nUse the /dcp compress flow by calling the compress tool when older context can be safely summarized.\nIf the current task is in an important critical section, you may delay briefly, but you must compress before usage reaches {{hard}}%.\n{{hardMessage}}\nPreserve decisions, user requirements, inspected files, changed files, important tool outputs, open questions, and blockers.\nCompress obsolete exploration, repeated logs, resolved tool output, and redundant discussion.\n</dcp-system-reminder>`,
  "turn-nudge": `<dcp-turn-reminder>\nA full turn completed while context is above the DCP minimum. If there is closed context, consider compressing it before continuing.\n</dcp-turn-reminder>`,
  "iteration-nudge": `<dcp-iteration-reminder>\nMany messages have occurred since the last user request. If old context is no longer active, call the compress tool on safe ranges.\n</dcp-iteration-reminder>`,
  "manual-compress": `<dcp-manual-trigger>\nThe user requested /dcp compress{{focus}}.\nInspect the visible <dcp-message> ids. If there is closed, old, or low-priority context, call the compress tool now with one or more ranges and high-fidelity summaries.\nIf this exact moment is critical, you may defer briefly, but do not wait beyond the hard context limit.\n</dcp-manual-trigger>`,
};

export class PromptStore {
  constructor(private readonly cwd: string, private readonly config: DcpConfig) {}

  get(key: PromptKey): string {
    if (!this.config.experimental.customPrompts) return DEFAULT_PROMPTS[key];
    const path = join(this.cwd, ".pi", "dcp", "prompts", `${key}.md`);
    if (!existsSync(path)) {
      mkdirSync(join(this.cwd, ".pi", "dcp", "prompts"), { recursive: true });
      writeFileSync(path, DEFAULT_PROMPTS[key], "utf8");
      return DEFAULT_PROMPTS[key];
    }
    return readFileSync(path, "utf8");
  }

  render(key: PromptKey, vars: Record<string, string | number | undefined>): string {
    let text = this.get(key);
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{{${name}}}`, value == null ? "" : String(value));
    return text;
  }
}
