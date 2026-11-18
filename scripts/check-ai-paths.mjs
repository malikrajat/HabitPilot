#!/usr/bin/env node
/**
 * Architectural guard: AI provider transports and request pipelines must only
 * be constructed inside the sanctioned enforcement layer.
 *
 * Allowed:
 *   - apps/web/src/lib/localTransport.ts        definition
 *   - apps/web/src/lib/desktop.ts               definition
 *   - apps/web/src/state/AppProvider.tsx        constructs pipelines/transports
 *
 * Everything else in apps/web/src must go through the provider context.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_SRC = join(ROOT, "apps/web/src");

const ALLOWED = new Set([
  "apps/web/src/lib/localTransport.ts",
  "apps/web/src/lib/desktop.ts",
  "apps/web/src/state/AppProvider.tsx",
]);

const CHECKS = [
  { name: "local transport construction", regex: /new\s+LocalHttpTransport\b/ },
  { name: "desktop transport construction", regex: /new\s+DesktopHttpTransport\b/ },
  { name: "AI pipeline construction", regex: /new\s+AiRequestPipeline\b/ },
  { name: "provider HTTP call", regex: /\bfetch\(\s*`?\$\{[^}]*\}\/(?:v1\/chat\/completions|api\/chat|messages)/ },
];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

const findings = [];
for await (const file of walk(WEB_SRC)) {
  const relativePath = relative(ROOT, file).replaceAll("\\", "/");
  if (ALLOWED.has(relativePath)) continue;
  const text = await readFile(file, "utf8");
  const isDefinition =
    relativePath.endsWith("localTransport.ts") || relativePath.endsWith("desktop.ts");
  for (const check of CHECKS) {
    if (isDefinition && check.name.includes("construction")) continue;
    if (check.regex.test(text)) {
      findings.push({ file: relativePath, check: check.name });
    }
  }
}

if (findings.length > 0) {
  console.error("AI enforcement bypass detected:");
  for (const finding of findings) {
    console.error(`  - ${finding.file}: ${finding.check}`);
  }
  console.error(
    "All AI requests must go through AiRequestPipeline or the GatewayClient approval flow.",
  );
  process.exit(1);
}

console.log("AI path guard passed: transports and pipelines are only constructed in the enforcement layer.");
