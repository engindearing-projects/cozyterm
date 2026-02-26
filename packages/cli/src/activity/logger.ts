// Activity logger — sends session summaries to the engie brain
// Fire-and-forget POST to activity server at :18790
// Never blocks or throws — if the server is down, silently no-ops

const ACTIVITY_URL = process.env.ACTIVITY_URL || "http://localhost:18790";
const PLATFORM = "cozyterm-cli";

interface SessionSummary {
  prompt: string;
  result: string;
  tools: string[];
  toolCalls: number;
  filesChanged: string[];
  tokenUsage: { input: number; output: number };
  duration: number;
  provider: string;
  model: string;
  mode: "coder" | "planner";
  cwd: string;
}

/**
 * Log a completed agent session to the engie activity server.
 * Sends two entries: the user prompt and the session summary.
 * Fire-and-forget — never throws.
 */
export async function logSession(summary: SessionSummary): Promise<void> {
  const sessionKey = `cozy-${Date.now()}`;

  try {
    // Log the user's prompt
    await post("/activity", {
      platform: PLATFORM,
      session_key: sessionKey,
      role: "user",
      content: summary.prompt,
      metadata: {
        cwd: summary.cwd,
        mode: summary.mode,
        provider: summary.provider,
        model: summary.model,
      },
    });

    // Build a concise summary of what happened
    const toolSummary = summary.toolCalls > 0
      ? `${summary.toolCalls} tool calls (${[...new Set(summary.tools)].join(", ")})`
      : "no tools used";

    const fileSummary = summary.filesChanged.length > 0
      ? `files: ${summary.filesChanged.join(", ")}`
      : "";

    const durationSec = (summary.duration / 1000).toFixed(1);
    const tokens = summary.tokenUsage.input + summary.tokenUsage.output;

    const parts = [
      toolSummary,
      fileSummary,
      `${tokens} tokens`,
      `${durationSec}s`,
    ].filter(Boolean);

    const content = `${summary.result.slice(0, 500)}`;

    // Log the session result
    await post("/activity", {
      platform: PLATFORM,
      session_key: sessionKey,
      role: "assistant",
      content,
      metadata: {
        tools: [...new Set(summary.tools)],
        toolCalls: summary.toolCalls,
        filesChanged: summary.filesChanged,
        tokenUsage: summary.tokenUsage,
        duration: summary.duration,
        mode: summary.mode,
        summary: parts.join(" · "),
      },
    });
  } catch {
    // Activity server not running — that's fine
  }
}

/**
 * Extract file paths from agent tool calls.
 * Looks at tool_start events for read, edit, write operations.
 */
export function extractFilesChanged(
  history: readonly { role: string; content: string; toolCalls?: unknown[] }[],
): string[] {
  const files = new Set<string>();

  for (const msg of history) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls as Array<{ name: string; arguments: Record<string, unknown> }>) {
      const path = tc.arguments?.path as string | undefined;
      if (!path) continue;

      if (["edit_file", "write_file"].includes(tc.name)) {
        files.add(path);
      }
    }
  }

  return [...files];
}

/**
 * Count total tool calls in agent history.
 */
export function countToolCalls(
  history: readonly { role: string; content: string; toolCalls?: unknown[] }[],
): { count: number; tools: string[] } {
  const tools: string[] = [];

  for (const msg of history) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls as Array<{ name: string }>) {
      tools.push(tc.name);
    }
  }

  return { count: tools.length, tools };
}

async function post(path: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    await fetch(`${ACTIVITY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
