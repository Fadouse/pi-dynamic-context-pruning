# Pi Dynamic Context Pruning

`pi-dynamic-context-pruning` is a Pi extension aligned with the feature model of `opencode-dynamic-context-pruning`.

It implements DCP-style compression rather than Pi native compaction:

- Pi session files remain complete.
- The extension rewrites only the provider request payload.
- Visible messages get stable XML IDs: `<dcp-message id="m0001">`.
- The model calls the `compress` tool to summarize old ranges.
- Active ranges are replaced with `<dcp-compressed-block>` summaries.
- Blocks are reversible with `/dcp decompress` and `/dcp recompress`.

## Install

```bash
cd /mnt/d/Code/Agentic/pi/pi-dynamic-context-pruning
npm install
pi install .
```

Direct test:

```bash
pi -e /mnt/d/Code/Agentic/pi/pi-dynamic-context-pruning/index.ts
```

## Config paths

Later files override earlier files:

```text
~/.pi/agent/dcp/config.jsonc
Config/dcp.jsonc
.pi/dcp/config.jsonc
```

State and logs:

```text
.pi/dcp/state.json
.pi/dcp/logs/
.pi/dcp/prompts/*.md
```

See `examples/config.jsonc` and `dcp.schema.json`.

## Commands

```text
/dcp help
/dcp context
/dcp stats
/dcp compress [focus]
/dcp decompress <n|bId>
/dcp recompress <n|bId>
/dcp manual [on|off]
/dcp auto [on|off]
/dcp threshold <percent>
/dcp sweep [n]
```

`/dcp compact` is accepted as an alias for `/dcp compress`, but it still uses DCP compression and never calls Pi native `ctx.compact()`.

## OpenCode DCP alignment

Implemented alignment areas:

- range compression
- message-id injection
- reversible compression blocks
- manual mode
- context/turn/iteration nudges
- hard-limit nudge
- `/dcp context`
- `/dcp stats`
- `/dcp sweep`
- `/dcp decompress`
- `/dcp recompress`
- protected tools
- protected file patterns
- turn protection for error purging
- automatic deduplication strategy
- automatic purgeErrors strategy
- custom prompt overrides
- per-model threshold overrides
- compression timing stats
- stale/overlap warnings
- provider payload debug logging

## Automatic nudges

Defaults:

```jsonc
"autoCompress": {
  "enabled": true,
  "thresholdPercent": 75,
  "hardLimitPercent": 95,
  "minContextPercent": 50,
  "nudgeFrequency": 1,
  "iterationNudgeThreshold": 15,
  "nudgeForce": "soft",
  "summaryBuffer": true,
  "modelThresholds": {}
}
```

At threshold, DCP injects a reminder containing current tokens, total context window, current percentage, threshold, and hard limit. The model may delay during critical work, but is instructed to compress before the hard limit.

Per-model override example:

```jsonc
"autoCompress": {
  "modelThresholds": {
    "anthropic/claude-sonnet-4": {
      "thresholdPercent": 70,
      "hardLimitPercent": 92
    }
  }
}
```

## Compress tool schema

```json
{
  "topic": "Auth System Exploration",
  "content": [
    {
      "startId": "m0003",
      "endId": "m0012",
      "summary": "Complete high-fidelity summary of the range."
    }
  ]
}
```

The extension validates unknown IDs, reversed ranges, overlapping active blocks, protected user messages, protected tools, and protected file patterns.

## Strategies

### Deduplication

When enabled, duplicate tool/function result messages are hidden with DCP blocks. The original Pi session entries remain intact.

```jsonc
"strategies": {
  "deduplication": {
    "enabled": true,
    "protectedTools": []
  }
}
```

### Purge errors

When enabled, errored tool/result messages older than the configured turn count are hidden with DCP blocks. `turnProtection` can delay this for recent turns.

```jsonc
"strategies": {
  "purgeErrors": {
    "enabled": true,
    "turns": 4,
    "protectedTools": []
  }
}
```

### Sweep

`/dcp sweep` compresses tool/result messages since the last user message. `/dcp sweep 10` compresses the last ten eligible tool/result messages. It respects `commands.protectedTools` and `protectedFilePatterns`.

## Protection

Default protected tools are exactly Pi built-in tools documented in Pi usage.md and merged into command and strategy protection:

```text
read, bash, edit, write, grep, find, ls
```

Additional config:

```jsonc
"commands": { "protectedTools": ["mcp_*"] },
"compress": { "protectedTools": ["read", "bash", "edit", "write", "grep", "find", "ls"] },
"protectedFilePatterns": ["*.env", "**/secrets/*"]
```

## Custom prompts

Set:

```jsonc
"experimental": {
  "customPrompts": true
}
```

The extension creates editable prompt files under:

```text
.pi/dcp/prompts/
```

Supported prompt files:

```text
system.md
context-limit-nudge.md
turn-nudge.md
iteration-nudge.md
manual-compress.md
```

## Debugging

```jsonc
"debug": true,
"logProviderPayloads": true
```

Logs are written to:

```text
.pi/dcp/logs/
```

## Provider support

The implementation targets Pi provider payloads with `payload.messages`, covering OpenAI-compatible providers, Anthropic, Claude Code OAuth, and GPT OAuth when Pi serializes them through the standard message array.
