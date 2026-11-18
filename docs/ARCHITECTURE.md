# Architecture

## Goals

1. Local-first: health data lives in IndexedDB (web/PWA) or SQLite (desktop).
2. AI consent is explicit, granular, versioned and revocable.
3. The same rules apply on every surface, and the server enforces them again.
4. Non-LLM analytics never depend on a provider.
5. Credentials never reach browser code.

## Package boundaries

### `@habitpilot/consent-core`

Pure domain logic. No persistence, no network, no UI.

| Module | Responsibility |
| --- | --- |
| `taxonomy.ts` | Categories, providers, purposes, task ceilings, policy version, exact user-facing messages |
| `state.ts` | Immutable grant/revoke/external-access transitions + audit entries |
| `ledger.ts` | `ConsentService` coordinating a `ConsentStateStore`; serializes writes |
| `evaluate.ts` | The authorization gate; returns a structured decision |
| `payload.ts` | Category projection, record windows, raw-capture detection |
| `pipeline.ts` | The only sanctioned AI request path (preview + complete) |

Storage adapters are deliberately outside this package:

- web: `LocalConsentStore` over IndexedDB;
- desktop: same class, routed to SQLite through the Tauri bridge;
- gateway: `ServerConsentDatabase` keyed by authenticated user.

### `@habitpilot/health-analytics`

Deterministic functions with no I/O and no AI dependency. Outputs include
`generatedBy: "deterministic-analytics"` on summaries, and projections carry
`kind: "estimate"` plus a disclaimer.

### `apps/web`

- `state/AppProvider.tsx` orchestrates provider configuration, consent display,
  preview/send calls and gateway connection.
- Local providers call `AiRequestPipeline` directly.
- Remote providers in a browser are only allowed through the gateway: the web
  app has no code path that accepts or stores a provider API key.
- On desktop, the transport is swapped for a Rust proxy; the pipeline and consent
  rules are unchanged.

### `services/gateway`

Fastify server that:

1. authenticates a bearer session token (HMAC-SHA256);
2. rate limits per user;
3. resolves the provider from **server configuration only**;
4. rejects a client-declared provider that differs;
5. sanitizes the snapshot to known fields and bounded arrays;
6. evaluates consent against server-side records using `consent-core`;
7. builds a second minimized payload;
8. calls the provider with a server-held credential;
9. audits metadata, returns text and transmission metadata;
10. never logs or persists request bodies.

### `apps/desktop`

Tauri v2 shell (primary target):

- SQLite `app_state(key, json)` for consent, settings, provider config and local
  health data;
- `keyring` for credentials (Windows Credential Manager / DPAPI);
- `ai_complete` command performs provider HTTP calls so the credential never
  enters the webview;
- `secret_status` only reports presence; no command returns the secret;
- first-run setup (`src/screens/DesktopSetup.tsx`) covers storage, provider and
  permission expectations;
- native menu (`Go`/`HabitPilot`) emits `habitpilot:navigate` events and opens
  the data folder;
- `desktop_info` exposes paths, version and credential backend for the setup UI;
- a trusted-origin permission handler allows only camera/microphone and denies
  every other webview permission.

### Sensors (`apps/web/src/lib/sensors.ts`)

Local-only capture used by the **Sensors & observations** screen:

- `getUserMedia` is called only from an explicit button press;
- camera frames are downscaled to 64×48 in memory, compared for movement, then
  discarded — no frame is retained;
- audio uses an `AnalyserNode` for RMS level only; no recorder exists;
- derived text summaries can be stored in local consent-aware health data;
- stopping releases tracks, closes the audio context and clears timers;
- `sensorMath.ts` holds the pure, tested frame/RMS helpers.

The device permission is **not** AI consent. Even with camera access, an AI
request must still pass the observation category grant and per-request
confirmation, and raw media is rejected by the payload guard.

## Request lifecycle (browser, remote provider)

```
AI Assistant
  -> previewAi() (shared evaluateConsent for disclosure, no transmission)
  -> user reviews disclosure / confirms sensitive request
  -> GatewayClient.complete() with selected categories + sanitized snapshot
  -> gateway auth + rate limit
  -> gateway resolves provider from env
  -> gateway evaluateConsent() against server consent records
  -> gateway buildMinimalPayload()
  -> provider API (credential from env)
  -> { text, transmission } back to UI
```

A missing permission produces the exact message:

> AI data-sharing permission is not enabled. Visit Privacy & AI Settings to configure your preferences.

No provider produces:

> No AI provider is configured. Configure a provider in AI Settings.

## Consent record shape

For local providers, consent changes are written locally (IndexedDB or SQLite)
with timestamps and policy versions. For gateway-routed providers, the same
record shape is written server-side and returned to the UI; the server record is
authoritative and is what the gateway checks before every transmission.

```
ConsentGrant {
  category, providerId, purpose,
  policyVersion, grantedAt, updatedAt, revokedAt
}
ExternalAccessSetting { providerId, enabled, policyVersion, updatedAt }
ConsentAuditEntry { action, at, policyVersion, category?, providerId?, purpose?, metadata? }
```

`metadata` is restricted to non-health values: task id, decision code, category
names, counts, actor. There is no API that accepts payload content into the audit
log.

## Data minimization

- The payload builder projects a snapshot through the approved categories only.
- Unknown fields never survive projection.
- Recent mode caps each section (default 14 records sorted by date).
- Complete history widens the window only when `history.complete` is approved and
  the request is explicitly confirmed.
- `history.complete` alone authorizes no other category.
- `findRawCapture` rejects `Uint8Array`, `ArrayBuffer`, `Blob`, data URLs and
  capture-named fields even though the builder never emits them.

## Invariants to preserve when extending

1. Never construct a payload before `decision.allowed`.
2. Never call a transport from UI code; add tasks to the registry and go through
   the pipeline/gateway.
3. Never add a category without updating `DATA_CATEGORY_DEFINITIONS`, task
   ceilings, payload projection and tests.
4. Never treat provider configuration, locality or model capability as consent.
5. Bump the policy version when the meaning or scope of consent changes.
6. Keep consent metadata and health data in separate stores.
7. Do not add a client-side credential field "just for development".
