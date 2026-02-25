#!/usr/bin/env bun

// Engie-Coder Agentic Tool Loop
// Parses <tool_call> blocks from model output, executes tools, feeds results
// back, and repeats until the model gives a final answer or hits limits.
//
// Trace collection: successful runs get saved to trainer/data/traces/ in the
// same format as the existing tool-collector.mjs for Forge training.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { getToolSchemaText, executeTool } from "./tools.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const TRACES_DIR = resolve(PROJECT_DIR, "trainer", "data", "traces");

const DEFAULT_MODEL = "engie-coder:latest";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_TOOL_CALLS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const OLLAMA_URL = "http://localhost:11434";

// ── Tool Call Parsing ───────────────────────────────────────────────────────

// Match <tool_call>...</tool_call> XML tags
const TOOL_CALL_XML_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Match ```json or ```bash code blocks containing tool call JSON
const TOOL_CALL_CODE_RE = /```(?:json|bash|tool)?\s*\n?\s*(\{[\s\S]*?"name"\s*:[\s\S]*?\})\s*\n?\s*```/g;
// Match bare JSON with "name" and "arguments" keys (last resort)
const TOOL_CALL_BARE_RE = /(?:^|\n)\s*(\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\})/gm;

/**
 * Attempt to convert single-quoted JSON strings to double-quoted.
 * Handles the common case where small models output Python-style strings.
 * This is best-effort — won't handle all edge cases but catches the common pattern.
 */
function fixSingleQuotedJson(str) {
  // State machine: walk through chars, swap unescaped single quotes to double quotes
  // while handling already-existing double quotes inside single-quoted values
  let result = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = i > 0 ? str[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") {
      // Swap single quote → double quote
      result += '"';
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && prev !== "\\") {
      result += '"';
      inDouble = !inDouble;
    } else if (ch === '"' && inSingle && prev !== "\\") {
      // Double quote inside single-quoted string → escape it
      result += '\\"';
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Parse tool calls from model output text.
 * Handles multiple formats the model might use:
 * 1. <tool_call>{...}</tool_call> (preferred)
 * 2. ```json\n{...}\n``` or ```bash\n{...}\n``` (common fallback)
 * 3. Bare JSON with "name" + "arguments" keys (last resort)
 */
export function parseToolCalls(text) {
  const toolCalls = [];
  let reasoning = text;

  function tryParse(jsonStr, fullMatch) {
    const trimmed = jsonStr.trim();
    // Try strict JSON first, then attempt to fix single-quoted strings
    // (common with small models that mix Python/JS style)
    for (const candidate of [trimmed, fixSingleQuotedJson(trimmed)]) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.name && typeof parsed.name === "string") {
          toolCalls.push({
            name: parsed.name,
            arguments: parsed.arguments || {},
          });
          reasoning = reasoning.replace(fullMatch, "").trim();
          return true;
        }
      } catch {
        // Try next candidate
      }
    }
    return false;
  }

  // Try XML tags first (preferred format)
  let match;
  TOOL_CALL_XML_RE.lastIndex = 0;
  while ((match = TOOL_CALL_XML_RE.exec(text)) !== null) {
    tryParse(match[1], match[0]);
  }

  // If no XML tags found, try code blocks
  if (toolCalls.length === 0) {
    TOOL_CALL_CODE_RE.lastIndex = 0;
    while ((match = TOOL_CALL_CODE_RE.exec(text)) !== null) {
      tryParse(match[1], match[0]);
    }
  }

  // If still nothing, try bare JSON
  if (toolCalls.length === 0) {
    TOOL_CALL_BARE_RE.lastIndex = 0;
    while ((match = TOOL_CALL_BARE_RE.exec(text)) !== null) {
      tryParse(match[1], match[1]);
    }
  }

  // Last resort: find any {"name":..."arguments":... structure (handles truncated
  // code blocks where the closing ``` was cut off by token limit)
  if (toolCalls.length === 0) {
    const lastBrace = text.lastIndexOf('{"name"');
    if (lastBrace !== -1) {
      let candidate = text.slice(lastBrace);
      // Try to balance braces — if truncated, close them
      let depth = 0;
      let end = 0;
      for (let i = 0; i < candidate.length; i++) {
        if (candidate[i] === "{") depth++;
        else if (candidate[i] === "}") depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      if (end > 0) {
        tryParse(candidate.slice(0, end), candidate.slice(0, end));
      } else {
        // Truncated — try closing unclosed braces
        candidate += "}".repeat(depth);
        tryParse(candidate, text.slice(lastBrace));
      }
    }
  }

  return { reasoning, toolCalls };
}

// ── System Prompt Builder ───────────────────────────────────────────────────

export function buildToolSystemPrompt(additionalContext = "") {
  const toolSchemas = getToolSchemaText();

  const parts = [
    `You are Engie, an expert coding assistant and project manager with tool access.`,
    ``,
    `## Using Tools`,
    `To use a tool, output:`,
    `<tool_call>`,
    `{"name": "tool_name", "arguments": {"key": "value"}}`,
    `</tool_call>`,
    ``,
    `You'll receive results in <tool_result> blocks. Use them to continue working.`,
    `When you have enough information, respond with plain text (no tool_call tags).`,
    `You can make multiple tool calls in one response.`,
    ``,
    `IMPORTANT: You MUST use tools to interact with the system. Do NOT write bash scripts for the user — execute commands directly with the bash tool. Do NOT guess at file contents — use read_file. Always use tools first, then explain results.`,
    ``,
    `## Examples`,
    ``,
    `### Listing files`,
    `User: What files are in the scripts directory?`,
    ``,
    `Assistant: Let me check.`,
    ``,
    `<tool_call>`,
    `{"name": "bash", "arguments": {"command": "ls -la ~/engie/scripts/"}}`,
    `</tool_call>`,
    ``,
    `[After receiving the tool result, you summarize the findings in plain text.]`,
    ``,
    `### Editing a file (read → edit pattern)`,
    `User: Change the port from 3000 to 8080 in server.js`,
    ``,
    `Assistant: Let me read the file first.`,
    ``,
    `<tool_call>`,
    `{"name": "read_file", "arguments": {"path": "/home/user/project/server.js"}}`,
    `</tool_call>`,
    ``,
    `[After seeing the file contents, make a targeted edit:]`,
    ``,
    `<tool_call>`,
    `{"name": "edit_file", "arguments": {"path": "/home/user/project/server.js", "old_string": "const port = 3000;", "new_string": "const port = 8080;"}}`,
    `</tool_call>`,
    ``,
    `## Available Tools`,
    ``,
    toolSchemas,
    ``,
    `## How to Edit Code`,
    `- ALWAYS read_file first to see the exact current content before editing.`,
    `- Use edit_file for targeted changes (preferred over write_file for existing files).`,
    `- Only use write_file for creating new files or complete rewrites.`,
    `- Include enough surrounding context in old_string to make it unique in the file.`,
    `- If edit_file says "N matches found", add more surrounding lines to old_string.`,
    `- Copy old_string exactly from read_file output — whitespace and indentation matter.`,
    ``,
    `## How to Work`,
    `- ALWAYS use tools to answer questions. Never fabricate output or guess.`,
    `- READ files before making changes. Don't guess at contents.`,
    `- For coding tasks: read the code, understand context, then modify.`,
    `- Break complex tasks into steps. Use tools iteratively.`,
    `- If a command fails, read the error and try a different approach.`,
    `- Store important decisions and findings in memory.`,
    ``,
    `## Be Curious`,
    `When given a task, explore first:`,
    `- Check what files exist before making assumptions`,
    `- Read related files to understand context`,
    `- Look at memory for relevant past decisions`,
    `- If you find something interesting or unexpected, mention it`,
  ];

  if (additionalContext) {
    parts.push("", "## Additional Context", additionalContext);
  }

  return parts.join("\n");
}

// ── Ollama API ──────────────────────────────────────────────────────────────
// Uses /api/generate (raw prompt) because the model's TEMPLATE is {{ .Prompt }}
// (raw passthrough). The /api/chat endpoint doesn't format messages correctly
// with this template.

function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(msg.content);
    } else if (msg.role === "user") {
      parts.push(`\nUser: ${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`\nAssistant: ${msg.content}`);
    }
  }
  parts.push("\nAssistant:");
  return parts.join("\n");
}

async function callOllama(messages, model, temperature) {
  const prompt = messagesToPrompt(messages);

  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      raw: true,
      stream: false,
      options: {
        num_predict: 8192,
        temperature: temperature ?? 0.7,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.response || "";
}

// ── Tool Loop ───────────────────────────────────────────────────────────────

/**
 * Run the agentic tool loop.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The user's message
 * @param {string} [opts.systemPrompt] - Additional system prompt context
 * @param {string} [opts.model] - Ollama model name (default: engie-coder:latest)
 * @param {number} [opts.temperature] - Sampling temperature (default: 0.7)
 * @param {number} [opts.maxIterations] - Max loop iterations (default: 10)
 * @param {number} [opts.maxToolCalls] - Max total tool calls (default: 25)
 * @param {number} [opts.timeoutMs] - Total timeout (default: 120000)
 * @param {string} [opts.cwd] - Working directory for tools
 *
 * @returns {Promise<{response, toolCalls, iterations, totalDurationMs, trace, finishReason}>}
 */
export async function runToolLoop(opts) {
  const {
    prompt,
    systemPrompt = "",
    model = DEFAULT_MODEL,
    temperature,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
  } = opts;

  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  const toolContext = { cwd: cwd || resolve(PROJECT_DIR, "workspace") };

  // Build messages
  const systemText = buildToolSystemPrompt(systemPrompt);
  const messages = [
    { role: "system", content: systemText },
    { role: "user", content: prompt },
  ];

  // Trace collection
  const trace = {
    toolCalls: [],
    iterations: 0,
  };

  let totalToolCalls = 0;
  let finalResponse = "";
  let finishReason = "complete";
  let nudged = false;

  for (let i = 0; i < maxIterations; i++) {
    trace.iterations = i + 1;

    // Check timeout
    if (Date.now() >= deadline) {
      finishReason = "timeout";
      break;
    }

    // Call the model
    let modelOutput;
    try {
      modelOutput = await callOllama(messages, model, temperature);
    } catch (err) {
      finishReason = "error";
      finalResponse = `Model error: ${err.message}`;
      break;
    }

    if (!modelOutput || modelOutput.trim().length === 0) {
      finishReason = "empty_response";
      break;
    }

    // Parse for tool calls
    const { reasoning, toolCalls } = parseToolCalls(modelOutput);

    // No tool calls → nudge once on first iteration, then accept as final answer
    if (toolCalls.length === 0) {
      if (i === 0 && !nudged) {
        // First response with no tools — nudge the model to use them
        nudged = true;
        messages.push({ role: "assistant", content: modelOutput });
        messages.push({ role: "user", content: 'You must use tools. Output a tool call like this exactly:\n\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>\n\nOr for reading files:\n\n<tool_call>\n{"name": "read_file", "arguments": {"path": "/path/to/file"}}\n</tool_call>\n\nDo it now.' });
        continue;
      }
      finalResponse = modelOutput;
      finishReason = "complete";
      break;
    }

    // Check tool call limit
    if (totalToolCalls + toolCalls.length > maxToolCalls) {
      // Return what we have with the reasoning
      finalResponse = reasoning || modelOutput;
      finishReason = "tool_limit";
      break;
    }

    // Add assistant message to conversation
    messages.push({ role: "assistant", content: modelOutput });

    // Execute each tool call and build results
    const resultParts = [];
    for (const tc of toolCalls) {
      totalToolCalls++;

      const execResult = await executeTool(tc.name, tc.arguments, toolContext);
      trace.toolCalls.push({
        name: tc.name,
        arguments: tc.arguments,
        ok: execResult.ok,
        result: execResult.result,
        durationMs: execResult.durationMs,
      });

      resultParts.push(
        `<tool_result name="${tc.name}">\n${execResult.result}\n</tool_result>`
      );

      // Check timeout between tool calls
      if (Date.now() >= deadline) {
        finishReason = "timeout";
        break;
      }
    }

    if (finishReason === "timeout") break;

    // Feed results back to the model
    messages.push({ role: "user", content: resultParts.join("\n\n") });

    // If this was the last iteration, note it
    if (i === maxIterations - 1) {
      finishReason = "max_iterations";
      // Give the model one more chance to respond without tools
      try {
        modelOutput = await callOllama(messages, model, temperature);
        finalResponse = modelOutput;
      } catch {
        finalResponse = reasoning || "Reached maximum iterations.";
      }
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Collect trace for Forge training (fire-and-forget)
  saveTrace({
    prompt,
    response: finalResponse,
    trace,
    finishReason,
    totalDurationMs,
    model,
  });

  return {
    response: finalResponse,
    toolCalls: trace.toolCalls,
    iterations: trace.iterations,
    totalDurationMs,
    trace,
    finishReason,
  };
}

// ── Trace Collection ────────────────────────────────────────────────────────

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function saveTrace({ prompt, response, trace, finishReason, totalDurationMs, model }) {
  try {
    // Only save traces worth training on
    if (finishReason !== "complete") return;
    if (trace.toolCalls.length === 0) return;
    if (!response || response.length < 50) return;
    if (trace.iterations >= 8) return; // too many iterations = probably confused

    if (!existsSync(TRACES_DIR)) {
      mkdirSync(TRACES_DIR, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10);
    const tracePath = resolve(TRACES_DIR, `${date}-agent.jsonl`);

    // Build training-format messages
    const traceMessages = [
      { role: "user", content: prompt },
    ];

    // Reconstruct the conversation from tool calls
    for (const tc of trace.toolCalls) {
      traceMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }],
      });
      traceMessages.push({
        role: "tool",
        tool_call_id: traceMessages[traceMessages.length - 1].tool_calls[0].id,
        content: (tc.result || "").slice(0, 4000),
      });
    }

    // Final response
    if (response) {
      traceMessages.push({ role: "assistant", content: response });
    }

    const record = {
      id: `trace_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      timestamp: new Date().toISOString(),
      prompt_hash: hashPrompt(prompt),
      prompt,
      trace: traceMessages,
      metadata: {
        type: "agent_loop",
        source: "engie-coder",
        model,
        tools_used: [...new Set(trace.toolCalls.map(tc => tc.name))],
        num_tool_calls: trace.toolCalls.length,
        num_messages: traceMessages.length,
        iterations: trace.iterations,
        finish_reason: finishReason,
        duration_ms: totalDurationMs,
      },
    };

    appendFileSync(tracePath, JSON.stringify(record) + "\n");
    console.log(
      `[Forge Agent] Trace saved — ${trace.toolCalls.length} tool calls, ` +
      `${trace.iterations} iterations, ${totalDurationMs}ms`
    );
  } catch (err) {
    console.error("[Forge Agent] Trace save failed:", err.message);
  }
}
