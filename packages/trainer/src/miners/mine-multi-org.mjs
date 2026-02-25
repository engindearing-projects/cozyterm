#!/usr/bin/env bun

// The Forge — Multi-Org Data Miner
// Mines training data from multiple GitHub orgs/users.
// Reuses the core mining logic from mine-org-data.mjs but iterates across sources.

import { execSync } from "child_process";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const CLAUDE_URL = "http://127.0.0.1:18791";
const OLLAMA_URL = "http://localhost:11434";

if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── Sources to mine ─────────────────────────────────────────────────────────

const SOURCES = [
  { name: "jfuginay", maxRepos: 20, maxItems: 6 },
  { name: "engindearing-projects", maxRepos: 20, maxItems: 6 },
  { name: "BloomTech-Labs", maxRepos: 200, maxItems: 15 },
];

const DELAY_MS = 2000;
let pairsCollected = 0;
let pairsSkipped = 0;
let promptsSeen = new Set();

// Load existing prompt hashes to avoid dupes with previous runs
try {
  const { getDb } = await import("./forge-db.js");
  const db = getDb();
  const rows = db.prepare("SELECT prompt_hash FROM training_pairs").all();
  for (const r of rows) promptsSeen.add(r.prompt_hash);
  console.log(`  Loaded ${promptsSeen.size} existing prompt hashes for dedup\n`);
} catch {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }
}

function hashPrompt(p) { return createHash("sha256").update(p).digest("hex").slice(0, 16); }
function todayFile() { return resolve(RAW_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callClaude(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch(`${CLAUDE_URL}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: "sonnet" }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    const text = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
    return { response: text, durationMs: Date.now() - start };
  } catch { return { response: null, durationMs: Date.now() - start }; }
}

async function callOllama(prompt) {
  const start = Date.now();
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "engie-coder:latest",
        messages: [
          { role: "system", content: "You are Engie, an expert coding assistant. Write clean, well-structured code with clear explanations." },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) return { response: null, durationMs: Date.now() - start };
    const data = await resp.json();
    return { response: data.message?.content ?? null, durationMs: Date.now() - start };
  } catch { return { response: null, durationMs: Date.now() - start }; }
}

async function collectPair(prompt, source) {
  const hash = hashPrompt(prompt);
  if (promptsSeen.has(hash)) { pairsSkipped++; return; }
  promptsSeen.add(hash);

  console.log(`\n  Collecting pair (${source})...`);
  console.log(`  Prompt: ${prompt.slice(0, 120)}...`);

  const [claude, local] = await Promise.all([callClaude(prompt), callOllama(prompt)]);

  if (!claude.response || !local.response) {
    console.log(`  SKIP: missing response (claude=${!!claude.response}, local=${!!local.response})`);
    pairsSkipped++; return;
  }
  if (!/```/.test(claude.response)) {
    console.log(`  SKIP: no code blocks in Claude response`);
    pairsSkipped++; return;
  }

  const pair = {
    id: `pair_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    prompt, prompt_hash: hash,
    complexity_score: null, routed_to: "mine", source,
    claude_response: claude.response, claude_duration_ms: claude.durationMs,
    local_response: local.response, local_duration_ms: local.durationMs,
    local_model: "engie-coder:latest",
  };

  appendFileSync(todayFile(), JSON.stringify(pair) + "\n");

  try {
    const { recordPair } = await import("./forge-db.js");
    recordPair({
      id: pair.id, prompt_hash: hash, timestamp: pair.timestamp,
      complexity_score: null, routed_to: "mine",
      claude_response_length: claude.response.length,
      local_response_length: local.response.length,
      claude_duration_ms: claude.durationMs, local_duration_ms: local.durationMs,
      local_model: "engie-coder:latest", has_code: true,
    });
  } catch {}

  pairsCollected++;
  console.log(`  SAVED pair ${pair.id} (claude=${claude.response.length}c/${claude.durationMs}ms, local=${local.response.length}c/${local.durationMs}ms) [total: ${pairsCollected}]`);
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

function detectStack(repoName) {
  const lower = repoName.toLowerCase();
  if (lower.includes("-fe") || lower.includes("frontend") || lower.includes("-ui")) return "React/JavaScript frontend";
  if (lower.includes("-be") || lower.includes("-api") || lower.includes("service-")) return "Node.js/TypeScript backend API";
  if (lower.includes("mobile") || lower.includes("ios") || lower.includes("android")) return "React Native mobile app";
  if (lower.includes("devops") || lower.includes("pipeline") || lower.includes("infra")) return "DevOps/infrastructure";
  if (lower.includes("python") || lower.includes("-py")) return "Python";
  return "full-stack JavaScript/TypeScript";
}

function issueToPrompt(repo, issue, stack) {
  const labels = issue.labels?.map(l => l.name).join(", ") || "";
  return `You are working on the "${repo}" repository (${stack}).

Issue #${issue.number}: ${issue.title}
${labels ? `Labels: ${labels}` : ""}

${issue.body ? issue.body.slice(0, 1500) : "(no description)"}

Write the code to implement this. Include relevant file paths, function signatures, and implementation. If it's a bug fix, show the fix. If it's a feature, show the key files and implementation.`;
}

function prToPrompt(repo, pr, stack) {
  return `You are working on the "${repo}" repository (${stack}).

PR #${pr.number}: ${pr.title}
Author: ${pr.author?.login || "unknown"}
State: ${pr.state}
${pr.body ? `\nDescription:\n${pr.body.slice(0, 1500)}` : ""}

Based on this PR description, write the key code changes that would implement this. Show the main files and implementation approach.`;
}

function commitToPrompt(repo, commit, stack) {
  return `You are working on the "${repo}" repository (${stack}).

A commit was made: "${commit.message}"
Author: ${commit.author} | Date: ${commit.date}

Write the code that would accomplish what's described. Show relevant files and clean, production-ready implementation.`;
}

function prReviewPrompt(repo, pr, diff, stack) {
  return `You are reviewing code on the "${repo}" repository (${stack}).

PR #${pr.number}: ${pr.title}
${pr.body ? `Description: ${pr.body.slice(0, 800)}` : ""}

Here's a portion of the diff:
\`\`\`diff
${diff.slice(0, 3000)}
\`\`\`

Review this code. Point out bugs, security issues, or improvements. Then show how you would implement this differently if there's a better approach. Include code.`;
}

// ── Mine a single org/user ──────────────────────────────────────────────────

async function mineSource(orgName, maxRepos, maxItems) {
  console.log(`\n${"█".repeat(60)}`);
  console.log(`  SOURCE: ${orgName}`);
  console.log(`${"█".repeat(60)}`);

  const repoJson = gh(`repo list ${orgName} --limit ${maxRepos * 2} --json name,pushedAt,isArchived --jq '[.[] | select(.isArchived == false)]'`);
  if (!repoJson) {
    console.log(`  Failed to list repos for ${orgName}`);
    return;
  }

  let repos = JSON.parse(repoJson);
  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));
  repos = repos.slice(0, maxRepos);
  console.log(`  Found ${repos.length} active repos\n`);

  for (const repo of repos) {
    const repoName = repo.name;
    const stack = detectStack(repoName);
    console.log(`\n${"─".repeat(50)}`);
    console.log(`  REPO: ${orgName}/${repoName} (${stack})`);
    console.log(`${"─".repeat(50)}`);

    let items = 0;

    // Open issues
    try {
      const data = gh(`issue list --repo ${orgName}/${repoName} --state open --limit 3 --json number,title,body,labels`);
      if (data) {
        for (const issue of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!issue.title || issue.title.length < 10) continue;
          await collectPair(issueToPrompt(repoName, issue, stack), `issue:${orgName}/${repoName}#${issue.number}`);
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    // Open PRs + reviews
    try {
      const data = gh(`pr list --repo ${orgName}/${repoName} --state open --limit 2 --json number,title,body,author,state`);
      if (data) {
        for (const pr of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!pr.title || pr.title.length < 10) continue;
          await collectPair(prToPrompt(repoName, pr, stack), `pr:${orgName}/${repoName}#${pr.number}`);
          items++; await sleep(DELAY_MS);

          if (items < maxItems) {
            const diff = gh(`pr diff --repo ${orgName}/${repoName} ${pr.number}`);
            if (diff && diff.length > 100 && diff.length < 50000) {
              await collectPair(prReviewPrompt(repoName, pr, diff, stack), `review:${orgName}/${repoName}#${pr.number}`);
              items++; await sleep(DELAY_MS);
            }
          }
        }
      }
    } catch {}

    // Merged PRs
    try {
      const data = gh(`pr list --repo ${orgName}/${repoName} --state merged --limit 3 --json number,title,body,author,state`);
      if (data) {
        for (const pr of JSON.parse(data)) {
          if (items >= maxItems) break;
          if (!pr.title || pr.title.length < 10) continue;
          await collectPair(prToPrompt(repoName, pr, stack), `merged:${orgName}/${repoName}#${pr.number}`);
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    // Recent commits
    try {
      const data = gh(`api repos/${orgName}/${repoName}/commits --jq '.[0:4] | .[] | .commit.message + "|||" + .commit.author.name + "|||" + .commit.author.date'`);
      if (data) {
        for (const line of data.split("\n")) {
          if (items >= maxItems) break;
          const [rawMsg, author, date] = line.split("|||");
          if (!rawMsg) continue;
          const msg = rawMsg.split("\n")[0];
          if (msg.length < 15 || /^merge/i.test(msg) || /^bump|^update deps|^chore\(deps\)/i.test(msg)) continue;
          await collectPair(commitToPrompt(repoName, { message: msg, author, date }, stack), `commit:${orgName}/${repoName}`);
          items++; await sleep(DELAY_MS);
        }
      }
    } catch {}

    console.log(`  → ${items} items from ${repoName}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== The Forge — Multi-Org Data Miner ===");
  console.log(`  Sources: ${SOURCES.map(s => s.name).join(", ")}`);
  console.log(`  Existing pairs: ${promptsSeen.size}`);
  console.log("");

  for (const source of SOURCES) {
    await mineSource(source.name, source.maxRepos, source.maxItems);
  }

  console.log(`\n${"█".repeat(60)}`);
  console.log(`  MINING COMPLETE`);
  console.log(`  New pairs collected: ${pairsCollected}`);
  console.log(`  Skipped (dupes/no-code): ${pairsSkipped}`);
  console.log(`  Total in DB: ${promptsSeen.size}`);
  console.log(`${"█".repeat(60)}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
