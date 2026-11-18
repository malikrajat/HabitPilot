# HabitPilot

Local-first health and habit tracking with **consent-gated AI**. Analytics work
without a model. AI is optional, explicit, per-category and revocable.

This repository is a working vertical slice:

- Deterministic analytics engine (BMI, trends, moving averages, goal progress,
  habits, eating duration, reminders, daily/weekly summaries) — no LLM.
- Shared consent domain package used by every surface.
- React + Vite web app / PWA backed by IndexedDB.
- Tauri v2 desktop app with local SQLite and OS-protected credentials.
- Fastify AI gateway that re-enforces consent server-side and never exposes keys.

## The three independent states

| State | Stored where | Grants data access? |
| --- | --- | --- |
| Provider configured | IndexedDB / SQLite / server env | **No** |
| Data-sharing consent granted | Consent ledger (per category, provider, purpose, policy version) | Yes, for that exact triple only |
| External provider access enabled | Consent ledger / gateway | **No** — it only permits transmission to a non-device provider |

There is no single "AI enabled" switch. A local Ollama model is not authorized
to read health data until the user grants that category. A configured remote
provider stays blocked until both category consent **and** external access exist.

A requirement-by-requirement audit, including partial and open items, is in
[`docs/COMPLIANCE-GAP-ANALYSIS.md`](docs/COMPLIANCE-GAP-ANALYSIS.md).

## Repository layout

```
packages/consent-core       Shared types, taxonomy, ledger, policy, payload, pipeline
packages/health-analytics  Deterministic health calculations (no AI)
apps/desktop               Tauri v2 desktop app (primary): SQLite, Windows Credential Manager, Rust AI proxy, native menu
apps/web                   Shared React UI, also shipped as a browser/PWA build
services/gateway           Fastify AI gateway (server-side consent, auth, rate limits)
```

## Desktop quick start (primary target)

Prerequisites: Node 22+, pnpm 11+, Rust (MSVC toolchain), Visual Studio Build
Tools, and the WebView2 runtime (preinstalled on Windows 11).

```bash
pnpm setup      # install + toolchain check
pnpm doctor     # re-run the check any time
pnpm dev        # start the desktop app
```

`pnpm dev` runs Vite and Tauri together and opens the HabitPilot window. On first
launch the setup flow opens automatically:

1. **Storage** — shows the SQLite folder and credential backend; can open the
   data folder in Explorer.
2. **AI provider** — optional local Ollama/LM Studio, or the secure gateway.
3. **Permissions** — explains that every category is denied until approved.

Provider configuration never grants data access. Finish setup, then grant
individual categories in **Privacy & AI Settings**. The **Setup** item in the
sidebar re-runs the flow.

### Desktop commands and menu

| Command | Effect |
| --- | --- |
| `pnpm dev` | Run the desktop app (Vite + Tauri) |
| `pnpm desktop:build` | Build the Windows installer and `.exe` |
| `pnpm desktop:info` | Print Tauri environment details |
| `pnpm check:desktop` | `cargo check` only |
| `pnpm doctor` | Node/pnpm/Rust/WebView2/Ollama check |

Native menu:

- **Go** → Dashboard (Ctrl+1), AI Assistant (Ctrl+2), Sensors & observations
  (Ctrl+3), Privacy & AI Settings (Ctrl+4), Consent audit log (Ctrl+5), Run
  setup again
- **HabitPilot** → Open data folder, Quit (Ctrl+Q)

Build output:

```
apps/desktop/src-tauri/target/release/habitpilot-desktop.exe
apps/desktop/src-tauri/target/release/bundle/nsis/HabitPilot_0.1.0_x64-setup.exe
```

The installer is unsigned; Windows SmartScreen will warn until you sign it.
Credentials are never written into the installer, SQLite database, or backups.

### Sensors & observations (camera / microphone)

Device access is requested in **Sensors & observations** (Go menu, Ctrl+3), not
in Privacy & AI. Sensor permission and AI data-sharing consent are separate.

- Press **Enable camera** / **Enable microphone** to trigger the OS/browser
  permission prompt. Nothing starts before that.
- Camera frames are downscaled in memory to count movement breaks, then
  discarded. No frame, image or recording is stored.
- Audio is analysed for input level only. No audio buffer is recorded or kept.
- **Save text observation** stores a derived summary locally (SQLite/IndexedDB).
  It is not shared automatically. Sending it to AI still requires granting
  `observations.posture_eye_screen` for a provider/purpose and approving the
  specific request.
- **Stop & revoke** stops all tracks immediately; leaving the screen also stops
  capture.
- Speaker/audio output has no permission prompt. Playback is controlled by
  Windows volume and the OS output device.
- Fully revoke device access in Windows: Settings → Privacy & security →
  Camera / Microphone. In a browser: site settings → Camera / Microphone.

Raw video and audio are rejected by the AI payload guard, so they cannot be
sent to a provider even with an observation category approved.

### Web / PWA (secondary)

The same UI also runs in a browser:

```bash
pnpm dev:web
```

Open the printed URL. The app opens in **Privacy & AI Settings → AI providers**
where you can:

1. Add a local Ollama / LM Studio / local-network endpoint (no credential).
2. Or connect the hosted gateway (remote providers).

Then go to **Data-sharing permission**, choose a purpose, and grant individual
categories. Finally use **AI Assistant** to review the disclosure and send.

Local Ollama needs CORS permission for the dev origin, e.g.:

```bash
OLLAMA_ORIGINS=http://localhost:5173 ollama serve
```

### Hosted gateway

```bash
cd services/gateway
cp .env.example .env        # fill in server-only values
pnpm --filter @habitpilot/gateway dev
# in another shell, mint a dev session token:
pnpm --filter @habitpilot/gateway token demo-user 12
```

Paste the gateway URL and token into **Privacy & AI Settings**. The token is
kept in memory only. Remote provider credentials never reach the browser.

### Desktop architecture

The desktop build reuses the shared React UI, but:

- app state and health data persist in local SQLite;
- provider credentials are written to Windows Credential Manager (DPAPI-backed)
  through the `keyring` crate;
- provider HTTP calls happen in Rust, so credentials never enter the webview;
- remote providers can be used directly with an OS-stored credential, or through
  the gateway if connected.

## Consent enforcement flow

Every AI call follows the same sequence in `packages/consent-core/src/pipeline.ts`
and again in `services/gateway/src/server.ts`:

1. Identify the task (fixed purpose and category ceiling).
2. Identify requested categories.
3. Resolve the active provider (never silently switch).
4. Check provider-level access (external access for non-device providers).
5. Check a live grant for **each** `(category, provider, purpose)` at the current
   policy version.
6. Require per-request confirmation for sensitive observations and complete history.
7. Build a minimized payload (bounded recent window unless complete history was
   explicitly approved).
8. Refuse binary captures (`findRawCapture`), then transmit.
9. Audit metadata only — never payload content.

Blocked decisions never reach a transport. Revocation takes effect on the next
request immediately.

## Consent policy versioning

`CONSENT_POLICY_VERSION` in `packages/consent-core/src/taxonomy.ts` is part of
every grant. Bumping it invalidates older grants (status `policy-outdated`) so
users must re-approve under the new policy. The service records the version
change in the audit log.

## Security expectations

- No provider key exists anywhere in the web bundle. `pnpm check:no-secrets`
  scans `src/` and `dist/` for key patterns and `VITE_*KEY/SECRET/TOKEN` usage.
- Gateway credentials come only from server environment variables.
- Gateway requests are authenticated with revocable/rotatable tokens, rate limited
  on AI and consent endpoints, and consent-checked against server-side records.
  Client-sent "consent granted" flags are ignored.
- Hosted sends require a single-use approval token; health data is not included in
  the authorization request.
- Provider switching is rejected; the server decides which provider is used, and
  grants are bound to its endpoint/model fingerprint.
- Upstream provider error bodies are discarded because they may echo personal data.
- Hosted consent is mirrored locally (metadata only) for on-device records.
- The web build injects a CSP; the AI-path guard fails builds that bypass the
  enforcement layer.
- Consent export contains metadata only: grants, timestamps, policy versions,
  audit log. No health records and no credentials.

## Tests

```bash
pnpm test          # consent-core, analytics, gateway, web helpers
pnpm typecheck
pnpm build
pnpm check:no-secrets
pnpm check:ai-paths
```

`pnpm verify` runs all of the above.

## Known limitations (residual)

- The gateway cannot prove a human read a disclosure; it proves that a two-phase
  authorization occurred and issues a single-use token.
- Approval tokens and session revocations are in-memory; use a shared store for
  multi-instance hosting.
- Gateway authentication is self-issued. Revocation/rotation exist, but production
  should use your identity provider.
- Consent metadata persists to `services/gateway/data/consent.json` by default;
  use a database with OS ACLs at scale.
- Sensor audio is level-only; eating/breathing observations are not derived from
  sound. Raw media is never stored or transmitted.
- Read-aloud uses local OS voices only; it stays off when no local voice exists.
- The CSP allows any HTTPS gateway origin so runtime gateway URLs work; tighten it
  if your gateway origin is fixed.
- Installer signing/notarization, auto-update, audit-retention UI and local-network
  sync remain out of scope.
