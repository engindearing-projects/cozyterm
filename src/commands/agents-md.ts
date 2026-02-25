// AGENTS.md generator — analyzes a project and creates an AGENTS.md file
// Similar to OpenCode's auto-generated project context file

import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, relative, extname } from "path";
import { glob } from "glob";

interface ProjectAnalysis {
  name: string;
  rootPath: string;
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  testFramework: string | null;
  buildTools: string[];
  entryPoints: string[];
  keyDirectories: string[];
  configFiles: string[];
  totalFiles: number;
  totalLines: number;
}

export async function generateAgentsMd(rootPath: string): Promise<string> {
  const analysis = await analyzeProject(rootPath);
  const md = renderAgentsMd(analysis);
  return md;
}

export async function writeAgentsMd(rootPath: string): Promise<string> {
  const md = await generateAgentsMd(rootPath);
  const outPath = join(rootPath, "AGENTS.md");
  writeFileSync(outPath, md, "utf-8");
  return outPath;
}

async function analyzeProject(rootPath: string): Promise<ProjectAnalysis> {
  const name = rootPath.split("/").pop() || "project";

  // Find all source files
  const allFiles = await glob("**/*", {
    cwd: rootPath,
    nodir: true,
    ignore: [
      "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
      "**/.venv/**", "**/__pycache__/**", "**/vendor/**", "**/target/**",
    ],
  });

  // Detect languages by extension
  const extCounts = new Map<string, number>();
  let totalLines = 0;

  for (const f of allFiles) {
    const ext = extname(f);
    if (ext) extCounts.set(ext, (extCounts.get(ext) || 0) + 1);

    try {
      const abs = join(rootPath, f);
      const stat = statSync(abs);
      if (stat.size < 500_000) { // Skip large files
        const content = readFileSync(abs, "utf-8");
        totalLines += content.split("\n").length;
      }
    } catch {
      // Skip unreadable
    }
  }

  const languages = detectLanguages(extCounts);
  const frameworks = detectFrameworks(rootPath);
  const packageManager = detectPackageManager(rootPath);
  const testFramework = detectTestFramework(rootPath);
  const buildTools = detectBuildTools(rootPath);
  const entryPoints = detectEntryPoints(rootPath, allFiles);
  const keyDirectories = detectKeyDirectories(allFiles);
  const configFiles = allFiles.filter((f) => isConfigFile(f)).slice(0, 20);

  return {
    name,
    rootPath,
    languages,
    frameworks,
    packageManager,
    testFramework,
    buildTools,
    entryPoints,
    keyDirectories,
    configFiles,
    totalFiles: allFiles.length,
    totalLines,
  };
}

function detectLanguages(extCounts: Map<string, number>): string[] {
  const langMap: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".cpp": "C++", ".c": "C",
    ".swift": "Swift", ".kt": "Kotlin", ".scala": "Scala",
  };

  const langs = new Map<string, number>();
  for (const [ext, count] of extCounts) {
    const lang = langMap[ext];
    if (lang) langs.set(lang, (langs.get(lang) || 0) + count);
  }

  return Array.from(langs.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

function detectFrameworks(root: string): string[] {
  const frameworks: string[] = [];
  const check = (file: string, fw: string) => {
    if (existsSync(join(root, file))) frameworks.push(fw);
  };

  // JS/TS frameworks
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.react) frameworks.push("React");
    if (deps.next) frameworks.push("Next.js");
    if (deps.vue) frameworks.push("Vue");
    if (deps.svelte) frameworks.push("Svelte");
    if (deps.express) frameworks.push("Express");
    if (deps.fastify) frameworks.push("Fastify");
    if (deps.ink) frameworks.push("Ink");
    if (deps["@angular/core"]) frameworks.push("Angular");
  } catch {}

  check("requirements.txt", "Python");
  check("Cargo.toml", "Rust/Cargo");
  check("go.mod", "Go Modules");

  return frameworks;
}

function detectPackageManager(root: string): string | null {
  if (existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  if (existsSync(join(root, "Pipfile.lock"))) return "pipenv";
  if (existsSync(join(root, "poetry.lock"))) return "poetry";
  if (existsSync(join(root, "Cargo.lock"))) return "cargo";
  if (existsSync(join(root, "go.sum"))) return "go";
  return null;
}

function detectTestFramework(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.jest) return "Jest";
    if (deps.vitest) return "Vitest";
    if (deps.mocha) return "Mocha";
    if (deps["@testing-library/react"]) return "React Testing Library";
  } catch {}

  if (existsSync(join(root, "pytest.ini")) || existsSync(join(root, "conftest.py"))) return "pytest";
  return null;
}

function detectBuildTools(root: string): string[] {
  const tools: string[] = [];
  if (existsSync(join(root, "Makefile"))) tools.push("Make");
  if (existsSync(join(root, "Dockerfile"))) tools.push("Docker");
  if (existsSync(join(root, ".github/workflows"))) tools.push("GitHub Actions");
  if (existsSync(join(root, "turbo.json"))) tools.push("Turborepo");
  if (existsSync(join(root, "nx.json"))) tools.push("Nx");
  return tools;
}

function detectEntryPoints(root: string, files: string[]): string[] {
  const entries: string[] = [];
  const common = [
    "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
    "src/app.ts", "src/app.js", "index.ts", "index.js", "main.ts", "main.go",
    "bin/", "cmd/", "app.py", "main.py", "manage.py",
  ];

  for (const entry of common) {
    if (entry.endsWith("/")) {
      if (files.some((f) => f.startsWith(entry))) entries.push(entry);
    } else if (files.includes(entry)) {
      entries.push(entry);
    }
  }

  // Check package.json main/bin
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    if (pkg.main) entries.push(pkg.main);
    if (pkg.bin) {
      for (const b of Object.values(pkg.bin)) entries.push(b as string);
    }
  } catch {}

  return [...new Set(entries)];
}

function detectKeyDirectories(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length > 1) dirs.add(parts[0]);
    if (parts.length > 2) dirs.add(parts.slice(0, 2).join("/"));
  }

  // Filter to likely important dirs
  const important = ["src", "lib", "app", "api", "cmd", "internal", "pkg", "test", "tests",
    "scripts", "bin", "public", "pages", "components", "routes", "services", "models",
    "utils", "config", "middleware"];

  return Array.from(dirs)
    .filter((d) => important.some((i) => d === i || d.startsWith(`src/${i}`)))
    .sort();
}

function isConfigFile(f: string): boolean {
  const name = f.split("/").pop() || "";
  return /^(\.env|\.gitignore|tsconfig|package\.json|Makefile|Dockerfile|docker-compose|\.eslintrc|\.prettierrc|jest\.config|vite\.config|next\.config|turbo\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml)/i.test(name);
}

function renderAgentsMd(p: ProjectAnalysis): string {
  const sections: string[] = [];

  sections.push(`# ${p.name}\n`);

  if (p.languages.length > 0) {
    sections.push(`## Languages\n${p.languages.join(", ")}\n`);
  }

  if (p.frameworks.length > 0) {
    sections.push(`## Frameworks\n${p.frameworks.join(", ")}\n`);
  }

  const meta: string[] = [];
  if (p.packageManager) meta.push(`Package manager: ${p.packageManager}`);
  if (p.testFramework) meta.push(`Test framework: ${p.testFramework}`);
  if (p.buildTools.length > 0) meta.push(`Build tools: ${p.buildTools.join(", ")}`);
  meta.push(`Files: ${p.totalFiles}`);
  meta.push(`Lines: ~${Math.round(p.totalLines / 1000)}k`);
  if (meta.length > 0) {
    sections.push(`## Project Info\n${meta.map((m) => `- ${m}`).join("\n")}\n`);
  }

  if (p.entryPoints.length > 0) {
    sections.push(`## Entry Points\n${p.entryPoints.map((e) => `- \`${e}\``).join("\n")}\n`);
  }

  if (p.keyDirectories.length > 0) {
    sections.push(`## Key Directories\n${p.keyDirectories.map((d) => `- \`${d}/\``).join("\n")}\n`);
  }

  if (p.configFiles.length > 0) {
    sections.push(`## Config Files\n${p.configFiles.map((f) => `- \`${f}\``).join("\n")}\n`);
  }

  sections.push(`## Conventions\n- Add project-specific conventions here\n- Code style, naming patterns, architecture decisions\n`);

  return sections.join("\n");
}
