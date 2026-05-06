import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { compressPrompt, contextReport, decompress, help, recompress, stats, sweep } from "./lib/commands.js";
import { applyCompression, CompressToolParameters, type CompressArgs } from "./lib/compress-tool.js";
import { loadConfig } from "./lib/config.js";
import { Logger } from "./lib/logger.js";
import { chooseNudge, systemPromptExtension } from "./lib/nudges.js";
import { preparePayload, syncMessageRefs } from "./lib/payload.js";
import { PromptStore } from "./lib/prompts.js";
import { loadState, saveState } from "./lib/state.js";
import { applyAutomaticStrategies } from "./lib/strategies.js";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function modelKey(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as any;
  if (!model) return undefined;
  return `${model.provider ?? model.providerId ?? model.providerID ?? "unknown"}/${model.id ?? model.modelId ?? model.modelID ?? "unknown"}`;
}

function hasDcpMarkers(payload: any): boolean {
  return JSON.stringify(payload).includes("<dcp-message") || JSON.stringify(payload).includes("<dcp-compressed-block");
}

const DCP_SUBCOMMANDS = ["help", "context", "stats", "compress", "decompress", "recompress", "manual", "auto", "threshold", "sweep"];

/**
 * Pi Dynamic Context Pruning entrypoint. Pi sessions stay immutable; this extension
 * builds a reversible DCP view in the `context` event, before Pi serializes the
 * messages for OpenAI/Anthropic-compatible providers.
 */
export default function piDynamicContextPruning(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const { config } = loadConfig(cwd);
  const { state, path: stateFile } = loadState(cwd);
  const prompts = new PromptStore(cwd, config);
  const logger = new Logger(cwd, config);

  if (!config.enabled) return;
  if (config.manualMode.enabled) state.runtime.manualMode = true;

  const persist = () => saveState(stateFile, state);

  const buildDcpContext = (messages: any[], ctx: ExtensionContext) => {
    syncMessageRefs(state, messages as any);
    const strategyBlocks = applyAutomaticStrategies(state, config);
    if (strategyBlocks.length) logger.debug("automatic strategies created blocks", strategyBlocks);

    const usage = ctx.getContextUsage();
    const nudge = chooseNudge(state, config, prompts, usage, modelKey(ctx));
    if (nudge.text) {
      state.runtime.lastNudgeTurn = state.runtime.turn;
      state.stats.nudges++;
      if (nudge.kind === "turn") state.stats.turnNudges++;
      if (nudge.kind === "iteration") state.stats.iterationNudges++;
      notify(ctx, `DCP: ${nudge.kind} nudge at ${usage?.percent?.toFixed(1) ?? "unknown"}% (${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"}).`, usage?.percent != null && usage.percent >= config.autoCompress.hardLimitPercent ? "warning" : "info");
    }

    const carrier = { messages };
    const result = preparePayload(carrier, state, nudge.text);
    persist();
    return result.changed ? carrier.messages : messages;
  };

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: `${event.systemPrompt}${systemPromptExtension(prompts)}` };
  });

  pi.on("turn_start", () => {
    state.runtime.turn++;
    persist();
  });

  // Primary DCP hook. This modifies Pi's normalized messages, so the model can
  // actually see <dcp-message id="..."> ranges before provider serialization.
  pi.on("context", async (event, ctx) => {
    return { messages: buildDcpContext(event.messages as any[], ctx) };
  });

  // Fallback/debug hook. Normally the context hook has already inserted DCP
  // markers; if not, this handles providers that bypass context transformation.
  pi.on("before_provider_request", (event, ctx) => {
    logger.payload(event.payload);
    if (hasDcpMarkers(event.payload)) return;
    if (event.payload && Array.isArray((event.payload as any).messages)) {
      const messages = buildDcpContext((event.payload as any).messages, ctx);
      (event.payload as any).messages = messages;
      return event.payload;
    }
  });

  pi.registerTool({
    name: "compress",
    label: "DCP Compress",
    description: "Compress old context ranges by replacing visible <dcp-message> ranges with high-fidelity summaries. Use when DCP asks you to prune context or the user runs /dcp compress.",
    parameters: CompressToolParameters,
    async execute(_toolCallId: string, input: CompressArgs) {
      const result = applyCompression(state, input, config);
      persist();
      return { content: [{ type: "text", text: result.text }], details: { blocks: result.blocks } };
    },
  });

  if (config.commands.enabled) {
    pi.registerCommand("dcp", {
      description: "Dynamic Context Pruning commands",
      getArgumentCompletions: (prefix: string) => {
        const parts = prefix.trimStart().split(/\s+/);
        const first = parts[0] ?? "";
        if (!prefix.includes(" ")) {
          const items = DCP_SUBCOMMANDS.filter((cmd) => cmd.startsWith(first)).map((cmd) => ({ value: cmd, label: cmd }));
          return items.length ? items : null;
        }
        const sub = first.toLowerCase();
        const argPrefix = parts[parts.length - 1] ?? "";
        if (sub === "manual" || sub === "auto") {
          const items = ["on", "off"].filter((v) => v.startsWith(argPrefix)).map((v) => ({ value: v, label: v }));
          return items.length ? items : null;
        }
        if (sub === "decompress" || sub === "recompress") {
          const wantActive = sub === "decompress";
          const items = state.blocks
            .filter((b) => b.active === wantActive)
            .flatMap((b) => [String(b.displayId), b.id])
            .filter((v) => v.startsWith(argPrefix))
            .map((v) => ({ value: v, label: v }));
          return items.length ? items : null;
        }
        return null;
      },
      handler: async (args, ctx) => {
        const [subRaw = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const sub = subRaw.toLowerCase();
        const tail = rest.join(" ");
        const usage = ctx.getContextUsage();
        const usageLine = usage ? `Usage: ${usage.tokens?.toLocaleString() ?? "unknown"} / ${usage.contextWindow.toLocaleString()} (${usage.percent?.toFixed(1) ?? "unknown"}%)` : "Usage: unknown";

        if (sub === "help" || sub === "") return ctx.ui.notify(help(), "info");
        if (sub === "context") return ctx.ui.notify(contextReport(state, usageLine), "info");
        if (sub === "stats") return ctx.ui.notify(stats(state, config), "info");

        if (sub === "compress" || sub === "compact") {
          pi.sendUserMessage(compressPrompt(prompts, tail), { deliverAs: "followUp" });
          return ctx.ui.notify("DCP compress request queued. The model should call the compress tool if safe.", "info");
        }

        if (sub === "decompress") {
          ctx.ui.notify(decompress(state, tail), "info");
          persist();
          return;
        }

        if (sub === "recompress") {
          ctx.ui.notify(recompress(state, tail), "info");
          persist();
          return;
        }

        if (sub === "manual") {
          if (!tail) state.runtime.manualMode = !state.runtime.manualMode;
          else if (tail === "on") state.runtime.manualMode = true;
          else if (tail === "off") state.runtime.manualMode = false;
          else return ctx.ui.notify("Usage: /dcp manual [on|off]", "warning");
          persist();
          return ctx.ui.notify(`DCP manual mode: ${state.runtime.manualMode ? "on" : "off"}`, "info");
        }

        if (sub === "auto") {
          if (tail === "on") state.runtime.autoEnabled = true;
          else if (tail === "off") state.runtime.autoEnabled = false;
          else return ctx.ui.notify("Usage: /dcp auto [on|off]", "warning");
          persist();
          return ctx.ui.notify(`DCP auto nudges: ${state.runtime.autoEnabled === false ? "off" : "on"}`, "info");
        }

        if (sub === "threshold") {
          const value = Number(tail);
          if (!Number.isFinite(value) || value < 1 || value > 99) return ctx.ui.notify("Usage: /dcp threshold <1-99>", "warning");
          state.runtime.thresholdPercent = value;
          persist();
          return ctx.ui.notify(`DCP threshold set to ${value}% for this session.`, "info");
        }

        if (sub === "sweep") {
          ctx.ui.notify(sweep(state, config, tail), "info");
          persist();
          return;
        }

        ctx.ui.notify(`Unknown DCP command: ${sub}\n\n${help()}`, "warning");
      },
    });
  }
}
