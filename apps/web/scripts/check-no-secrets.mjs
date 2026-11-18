#!/usr/bin/env node
/**
 * Fails the build if provider credentials or browser-side key handling appear
 * in the frontend source or production bundle.
 *
 * This is a safety net, not the primary control: the web app has no code path
 * that accepts or stores a provider API key.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIR = join(ROOT, "src");
const DIST_DIR = join(ROOT, "dist");

const SECRET_PATTERNS = [
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "DeepSeek key", regex: /\bsk-[a-f0-9]{32}\b/ },
  { name: "Provider env var used by the browser", regex: /\bVITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)\b/ },
  { name: "Server provider env var referenced in frontend", regex: /\b(OPENAI|ANTHROPIC|DEEPSEEK|GEMINI|HABITPILOT_AI)_API_KEY\b/ },
  { name: "Browser token persistence", regex: /localStorage\.(setItem|getItem)\([^)]*(token|key|secret)/i },
];

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (/\.(js|mjs|cjs|ts|tsx|jsx|html|css|map|json)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function scan(directory) {
  const findings = [];
  const info = await stat(directory).catch(() => null);
  if (!info) return findings;
  for await (const file of walk(directory)) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.regex.exec(text);
      if (match) {
        findings.push({
          file: relative(ROOT, file),
          pattern: pattern.name,
          excerpt: match[0].slice(0, 12) + "…",
        });
      }
    }
  }
  return findings;
}

const findings = [...(await scan(SOURCE_DIR)), ...(await scan(DIST_DIR))];

if (findings.length > 0) {
  console.error("Refusing to ship: potential credential exposure in the web app.");
  for (const finding of findings) {
    console.error(`  - ${finding.file}: ${finding.pattern} (${finding.excerpt})`);
  }
  console.error(
    "Provider keys belong on the gateway server or in OS-protected secret storage, never in the browser.",
  );
  process.exit(1);
}

console.log("No provider credentials or browser key handling found in src/ or dist/.");
