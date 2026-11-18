#!/usr/bin/env node
/**
 * HabitPilot desktop doctor.
 * Checks the toolchain needed to run the Tauri desktop app and prints the
 * exact commands. Optional tools (Ollama) only warn.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function command(cmd, args = []) {
  const result = spawnSync(cmd, args, { encoding: "utf8", shell: true });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

const lines = [];
let hardFailure = false;

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeOk = nodeMajor >= 22;
lines.push(`${nodeOk ? "OK  " : "FAIL"} Node ${process.versions.node} (need >= 22)`);
if (!nodeOk) hardFailure = true;

const pnpmVersion = command("pnpm --version");
lines.push(`${pnpmVersion ? "OK  " : "FAIL"} pnpm ${pnpmVersion ?? "not found"}`);
if (!pnpmVersion) hardFailure = true;

const cargoVersion = command("cargo --version");
lines.push(
  `${cargoVersion ? "OK  " : "WARN"} ${cargoVersion ?? "Rust/cargo not found — required for the desktop app"}`,
);

const rustcVersion = command("rustc --version");
if (cargoVersion && !rustcVersion) lines.push("WARN rustc not found");
if (cargoVersion && rustcVersion) lines.push(`OK   ${rustcVersion}`);

if (process.platform === "win32") {
  const webview =
    existsSync("C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application") ||
    existsSync("C:\\Program Files\\Microsoft\\EdgeWebView\\Application");
  lines.push(`${webview ? "OK  " : "WARN"} WebView2 runtime ${webview ? "installed" : "not detected"}`);
  const msvc = command("where link.exe");
  lines.push(
    `${msvc ? "OK  " : "WARN"} MSVC build tools ${msvc ? "available" : "not on PATH (Visual Studio Build Tools required)"}`,
  );
}

const deps = existsSync(new URL("../node_modules", import.meta.url));
lines.push(`${deps ? "OK  " : "FAIL"} dependencies ${deps ? "installed" : "missing — run pnpm install"}`);
if (!deps) hardFailure = true;

const tauriCli = command("pnpm --filter @habitpilot/desktop exec tauri --version");
lines.push(`${tauriCli ? "OK  " : "WARN"} ${tauriCli ?? "Tauri CLI not installed"}`);

async function checkOllama() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const ollama = await checkOllama();
lines.push(
  `${ollama ? "OK  " : "INFO"} Ollama ${ollama ? "is running on 127.0.0.1:11434" : "not detected (optional — needed only for local AI)"}`,
);

console.log("\nHabitPilot desktop doctor\n");
for (const line of lines) console.log(`  ${line}`);

console.log(`
Commands
  pnpm dev              start the desktop app (Vite + Tauri)
  pnpm desktop:build    build the Windows installer (NSIS)
  pnpm dev:web          run the browser/PWA version
  pnpm dev:gateway      run the hosted AI gateway
  pnpm verify           typecheck + tests + builds + secrets scan

Desktop app
  1. pnpm dev
  2. The first-run setup opens automatically: storage → provider → permissions.
  3. Native menu: Go (Ctrl+1…4), HabitPilot → Open data folder.

Data and credentials
  SQLite + consent records: %APPDATA%\\app.habitpilot.desktop\\habitpilot.db
  Provider keys: Windows Credential Manager (written by the native process only)
`);

process.exit(hardFailure ? 1 : 0);
