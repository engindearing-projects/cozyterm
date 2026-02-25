#!/usr/bin/env bun

// The Forge — Org Data Miner
// Scans MarekHealth GitHub repos for issues, PRs, and commits.
// Constructs coding prompts from real-world context and collects training pairs.
//
// Usage: bun ~/engie/trainer/mine-org-data.mjs [--max-repos 20] [--max-items 10]

import { execSync } from "child_process";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "data", "raw");
const CLAUDE_URL = "http://127.0.0.1:18791";
const OLLAMA_URL = "http://localhost:11434";
const ORG = "MarekHealth";

if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const MAX_REPOS = parseInt(args.find(a => a.startsWith("--max-repos="))?.split("=")[1] || "20");
const MAX_ITEMS_PER_REPO = parseInt(args.find(a => a.startsWith("--max-items="))?.split("=")[1] || "8");
const DELAY_MS = 3000; // pause between pairs to not overload

let pairsCollected = 0;
let pairsSkipped = 0;
let promptsSeen = new Set();

// ── Helpers ─────────────────────────────────────────────────────────────────

function gh(cmd) {
  try {
    return execSync(`gh ${cmd}`, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function hashPrompt(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function todayFile() {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(RAW_DIR, `${date}.jsonl`);
}

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
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
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
  } catch {
    return { response: null, durationMs: Date.now() - start };
  }
}

async function collectPair(prompt, source) {
  const hash = hashPrompt(prompt);
  if (promptsSeen.has(hash)) {
    pairsSkipped++;
    return;
  }
  promptsSeen.add(hash);

  console.log(`\n  Collecting pair (${source})...`);
  console.log(`  Prompt: ${prompt.slice(0, 120)}...`);

  const [claude, local] = await Promise.all([
    callClaude(prompt),
    callOllama(prompt),
  ]);

  if (!claude.response || !local.response) {
    console.log(`  SKIP: missing response (claude=${!!claude.response}, local=${!!local.response})`);
    pairsSkipped++;
    return;
  }

  if (!/```/.test(claude.response)) {
    console.log(`  SKIP: Claude response has no code blocks`);
    pairsSkipped++;
    return;
  }

  const pair = {
    id: `pair_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    timestamp: new Date().toISOString(),
    prompt,
    prompt_hash: hash,
    complexity_score: null,
    routed_to: "mine",
    source,
    claude_response: claude.response,
    claude_duration_ms: claude.durationMs,
    local_response: local.response,
    local_duration_ms: local.durationMs,
    local_model: "engie-coder:latest",
  };

  appendFileSync(todayFile(), JSON.stringify(pair) + "\n");

  // Record in DB
  try {
    const { recordPair } = await import("./forge-db.js");
    recordPair({
      id: pair.id,
      prompt_hash: hash,
      timestamp: pair.timestamp,
      complexity_score: null,
      routed_to: "mine",
      claude_response_length: claude.response.length,
      local_response_length: local.response.length,
      claude_duration_ms: claude.durationMs,
      local_duration_ms: local.durationMs,
      local_model: "engie-coder:latest",
      has_code: true,
    });
  } catch {}

  pairsCollected++;
  console.log(`  SAVED pair ${pair.id} (claude=${claude.response.length}c/${claude.durationMs}ms, local=${local.response.length}c/${local.durationMs}ms) [total: ${pairsCollected}]`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Prompt Builders ─────────────────────────────────────────────────────────

function issueToPrompt(repo, issue) {
  const labels = issue.labels?.map(l => l.name).join(", ") || "";
  return `You are working on the "${repo}" repository (Node.js/TypeScript, healthcare SaaS platform).

Issue #${issue.number}: ${issue.title}
${labels ? `Labels: ${labels}` : ""}

${issue.body ? issue.body.slice(0, 1500) : "(no description)"}

Write the code to implement this. Include the relevant file paths, function signatures, and implementation. If it's a bug fix, show the fix with before/after. If it's a feature, show the key implementation files.`;
}

function prToPrompt(repo, pr) {
  return `You are working on the "${repo}" repository (Node.js/TypeScript, healthcare SaaS platform).

A pull request was submitted:
PR #${pr.number}: ${pr.title}
Author: ${pr.author?.login || "unknown"}
State: ${pr.state}
${pr.body ? `\nDescription:\n${pr.body.slice(0, 1500)}` : ""}

Based on this PR description, write the key code changes that would implement this. Show the main files that would need to change and the implementation approach.`;
}

function commitToPrompt(repo, commit) {
  return `You are working on the "${repo}" repository (Node.js/TypeScript, healthcare SaaS platform).

A commit was made with this message:
"${commit.message}"

Author: ${commit.author}
Date: ${commit.date}

Based on this commit message, write the code that would accomplish what's described. Show the relevant files and implementation. Focus on writing clean, production-ready code.`;
}

function prReviewPrompt(repo, pr, diff) {
  return `You are reviewing code on the "${repo}" repository (Node.js/TypeScript, healthcare SaaS platform).

PR #${pr.number}: ${pr.title}
${pr.body ? `Description: ${pr.body.slice(0, 800)}` : ""}

Here's a portion of the diff:
\`\`\`diff
${diff.slice(0, 3000)}
\`\`\`

Review this code change. Point out any bugs, security issues, or improvements. Then show how you would implement this feature differently if you think there's a better approach. Include code.`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== The Forge — Org Data Miner ===");
  console.log(`  Org: ${ORG}`);
  console.log(`  Max repos: ${MAX_REPOS}`);
  console.log(`  Max items/repo: ${MAX_ITEMS_PER_REPO}`);
  console.log("");

  // Get active repos
  const repoJson = gh(`repo list ${ORG} --limit ${MAX_REPOS * 2} --json name,pushedAt,isArchived --jq '[.[] | select(.isArchived == false)]'`);
  if (!repoJson) {
    console.error("Failed to list repos. Check gh auth.");
    process.exit(1);
  }

  let repos = JSON.parse(repoJson);
  // Sort by most recently pushed
  repos.sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt));
  repos = repos.slice(0, MAX_REPOS);

  console.log(`  Found ${repos.length} active repos\n`);

  for (const repo of repos) {
    const repoName = repo.name;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  REPO: ${ORG}/${repoName}`);
    console.log(`${"═".repeat(60)}`);

    let itemsThisRepo = 0;

    // 1. Open issues
    try {
      const issuesJson = gh(`issue list --repo ${ORG}/${repoName} --state open --limit 5 --json number,title,body,labels`);
      if (issuesJson) {
        const issues = JSON.parse(issuesJson);
        for (const issue of issues) {
          if (itemsThisRepo >= MAX_ITEMS_PER_REPO) break;
          if (!issue.title || issue.title.length < 10) continue;
          await collectPair(issueToPrompt(repoName, issue), `issue:${repoName}#${issue.number}`);
          itemsThisRepo++;
          await sleep(DELAY_MS);
        }
      }
    } catch (e) {
      console.log(`  Issues error: ${e.message}`);
    }

    // 2. Open PRs
    try {
      const prsJson = gh(`pr list --repo ${ORG}/${repoName} --state open --limit 3 --json number,title,body,author,state`);
      if (prsJson) {
        const prs = JSON.parse(prsJson);
        for (const pr of prs) {
          if (itemsThisRepo >= MAX_ITEMS_PER_REPO) break;
          if (!pr.title || pr.title.length < 10) continue;
          await collectPair(prToPrompt(repoName, pr), `pr:${repoName}#${pr.number}`);
          itemsThisRepo++;
          await sleep(DELAY_MS);

          // Try to get diff for code review prompt
          if (itemsThisRepo < MAX_ITEMS_PER_REPO) {
            const diff = gh(`pr diff --repo ${ORG}/${repoName} ${pr.number}`);
            if (diff && diff.length > 100 && diff.length < 50000) {
              await collectPair(prReviewPrompt(repoName, pr, diff), `review:${repoName}#${pr.number}`);
              itemsThisRepo++;
              await sleep(DELAY_MS);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  PRs error: ${e.message}`);
    }

    // 3. Recently closed/merged PRs
    try {
      const closedJson = gh(`pr list --repo ${ORG}/${repoName} --state merged --limit 3 --json number,title,body,author,state`);
      if (closedJson) {
        const prs = JSON.parse(closedJson);
        for (const pr of prs) {
          if (itemsThisRepo >= MAX_ITEMS_PER_REPO) break;
          if (!pr.title || pr.title.length < 10) continue;
          await collectPair(prToPrompt(repoName, pr), `merged:${repoName}#${pr.number}`);
          itemsThisRepo++;
          await sleep(DELAY_MS);
        }
      }
    } catch (e) {
      console.log(`  Closed PRs error: ${e.message}`);
    }

    // 4. Recent commits (fill remaining slots)
    try {
      const logOutput = gh(`api repos/${ORG}/${repoName}/commits --jq '.[0:5] | .[] | { message: .commit.message, author: .commit.author.name, date: .commit.author.date }'`);
      if (logOutput) {
        // Parse NDJSON lines
        const commits = logOutput.split("\n}\n{").map((chunk, i, arr) => {
          if (i === 0) chunk = chunk;
          else chunk = "{" + chunk;
          if (i < arr.length - 1) chunk = chunk + "}";
          try { return JSON.parse(chunk); } catch { return null; }
        }).filter(Boolean);

        for (const commit of commits) {
          if (itemsThisRepo >= MAX_ITEMS_PER_REPO) break;
          // Skip merge commits and trivial ones
          const msg = commit.message?.split("\n")[0] || "";
          if (msg.length < 15) continue;
          if (/^merge/i.test(msg)) continue;
          if (/^bump|^update deps|^chore/i.test(msg)) continue;

          await collectPair(commitToPrompt(repoName, { ...commit, message: msg }), `commit:${repoName}`);
          itemsThisRepo++;
          await sleep(DELAY_MS);
        }
      }
    } catch (e) {
      console.log(`  Commits error: ${e.message}`);
    }

    console.log(`  → ${itemsThisRepo} items processed from ${repoName}`);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MINING COMPLETE`);
  console.log(`  Pairs collected: ${pairsCollected}`);
  console.log(`  Pairs skipped:   ${pairsSkipped}`);
  console.log(`${"═".repeat(60)}`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
