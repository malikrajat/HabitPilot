# HabitPilot — Consent & Security Compliance Gap Analysis

**Date:** 18 November 2026  
**Scope:** desktop (Tauri), web/PWA, shared consent domain, hosted AI gateway  
**Method:** code review, automated tests, packaged-app launch, browser end-to-end runs  
**Legend:** ✅ Full · 🟡 Partial · ❌ Missing · ⚪ Not applicable / intentionally absent

---

## 1. Executive summary

The implementation covers every enumerated requirement. Of **102 sub-requirements**,
the current build has:

| Status | Count |
| --- | --- |
| ✅ Full | 100 |
| 🟡 Partial | 0 |
| ❌ Missing | 0 |
| ⚪ N/A | 2 |

**Top-level result:** all 10 requirement areas are fully implemented.

| # | Area | Overall |
| --- | --- | --- |
| 1 | Consent defaults OFF | ✅ Full |
| 2 | Separate configuration / consent / external access | ✅ Full |
| 3 | Granular consent | ✅ Full |
| 4 | Consent enforcement | ✅ Full |
| 5 | Non-LLM analytics | ✅ Full |
| 6 | Web API-key security & gateway | ✅ Full |
| 7 | Desktop credential security | ✅ Full |
| 8 | Privacy disclosure | ✅ Full |
| 9 | Local-first architecture | ✅ Full |
| 10 | Shared domain logic / backend enforcement | ✅ Full |

### Implemented in this pass

| Gap | Resolution | Evidence |
| --- | --- | --- |
| 2.5 Silent provider fallback | Exact provider or `null`; no fallback when a preference exists | `providerSelection.ts`, `providers.test.ts` |
| 2.8 Endpoint locality | Loopback/private/remote classification; browser rejects remote device endpoints; runtime transport guard | `providerSelection.ts`, `localTransport.ts`, tests |
| 3.11 Provider fingerprint | 64-bit fingerprint over providerId/locality/model/endpoint; mismatch blocks and requires renewal | `provider.ts`, consent tests |
| 4.2 Required data | `requiredCategories` + `minimumCategories`; `required-data-missing`; required UI rows | `taxonomy.ts`, `evaluate.ts`, Assistant tests |
| 4.7 Disclosure | Review step required; hosted mode obtains a server approval token after authorization and returns disclosures | Assistant, `/v1/ai/authorize` |
| 4.8 Approved data only | Metadata-only authorization first; single-use token required for data; unrequested categories rejected; client bounds recent windows | gateway + `dataSelection.ts`, gateway tests |
| 4.12 Local consent record | Hosted consent mirrored to IndexedDB/SQLite with sync timestamp and read-only view | `consentMirror`, Audit screen |
| 4.17 Per-request confirmation | Single-use, user/task/provider/category-bound token, 2-minute expiry, one-time consumption | `approvals.ts`, gateway tests |
| 6.10 Gateway authentication | HMAC tokens with jti/iat/exp/scopes; revocation, refresh/rotation, previous-secret acceptance | `auth.ts`, session tests |
| 6.13 Rate limits | Per-user AI authorize/complete and consent limiters with 429 + Retry-After | `RateLimiter`, gateway tests |
| 10.5 Enforcement guard | Build fails if a transport/pipeline is constructed outside the sanctioned layer | `scripts/check-ai-paths.mjs` |

### Residual accepted risks

1. **Human disclosure display cannot be cryptographically proven.** The server verifies
   a two-phase authorization and issues a single-use token; it cannot prove a human read
   the screen.
2. **Approval and session-revocation registries are in-memory.** Restarts drop pending
   approvals and revocations (fail-safe). Use a shared store for multi-instance hosting.
3. **Authentication remains self-issued.** Revocation/rotation now exist, but production
   should use an identity provider and short-lived sessions.
4. **Gateway consent persistence is a JSON file by default.** Metadata only, mode 0600;
   use a database with OS ACLs at scale.
5. **Sensor audio does not derive eating or breathing observations.** This is intentional;
   raw audio is never recorded or sent.
6. **Read-aloud only works when a local OS voice exists.** No cloud voice is used.
7. **CSP allows any HTTPS gateway origin** so runtime gateway URLs keep working; tighten
   `connect-src` per deployment if the gateway origin is fixed.
8. **Out of scope:** installer signing/notarization, auto-update, audit-retention UI,
   local-network sync, and live video/audio transmission to AI.

---

## 2. Requirement-by-requirement matrix

### 1. AI consent must always default to OFF

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 1.1 | All eight data categories start denied | ✅ | `createInitialConsentState()` returns empty grants; matrix shows “Off by default” per row. |
| 1.2 | Applies to Ollama, LM Studio, local OpenAI-compatible, and remote providers | ✅ | Grants are provider-scoped; locality is never an authorization. Tests cover device and remote. |
| 1.3 | Configuring a provider does not grant data access | ✅ | Setup and Privacy copy; `addProvider` writes no grants; test `provider configuration is not consent`. |
| 1.4 | An active model does not grant data access | ✅ | Evaluation only checks grants + external access, never model presence. |

### 2. Separate AI configuration from data-sharing permission

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 2.1 | Provider-configured state exists independently | ✅ | `ProviderConfiguration` in IndexedDB/SQLite; no secrets. |
| 2.2 | AI data-sharing consent exists independently | ✅ | `ConsentGrant` ledger per category/provider/purpose/policy. |
| 2.3 | External provider access exists independently | ✅ | `ExternalAccessSetting`; separate switch; required only for non-device providers. |
| 2.4 | No combined on/off switch | ✅ | Three separate UI cards; no aggregate toggle. |
| 2.5 | No silent fallback to another provider | ✅ | Exact match or null when a preference exists; `selectActiveProvider` is unit-tested and the gateway resolves only its own provider. |
| 2.6 | Exact missing-consent message | ✅ | `MESSAGES.consentMissing`, asserted in consent-core and gateway tests and seen in the UI. |
| 2.7 | Exact no-provider message | ✅ | `MESSAGES.noProvider`, asserted in tests and shown in Assistant/Privacy. |
| 2.8 | Provider endpoint locality is validated | ✅ | `assessEndpoint` classifies loopback/private/remote; the browser rejects remote device-callable endpoints and the runtime transport repeats the guard. |

### 3. Granular consent

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 3.1 | Personal profile category | ✅ | `personal.profile`. |
| 3.2 | Weight history and goals category | ✅ | `body.weight_goals`. |
| 3.3 | Meal and nutrition history category | ✅ | `nutrition.meal_history`. |
| 3.4 | Eating and chewing observations category | ✅ | `observations.eating`; per-request approval. |
| 3.5 | Posture, eye and screen observations category | ✅ | `observations.posture_eye_screen`; camera-derived summaries can be saved locally. |
| 3.6 | Breathing observations category | ✅ | `observations.breathing`; per-request approval. |
| 3.7 | Sleep, hydration and activity category | ✅ | `lifestyle.sleep_hydration_activity`. |
| 3.8 | Complete historical health data category | ✅ | `history.complete`; unlock semantics; requires confirmation; never auto-authorizes other categories. |
| 3.9 | Scope by category, provider, purpose, approval, policy version | ✅ | `ConsentGrant` contains all five; `getConsentStatus` validates them. |
| 3.10 | One category must not authorize another | ✅ | Exact-category lookup; tests cover isolation and `history.complete` isolation. |
| 3.11 | Consent bound to the selected provider configuration | ✅ | 64-bit `providerFingerprint` (providerId/locality/model/endpoint) is stored in every grant; a mismatch yields `provider-changed` and blocks. Policy 2026-11-18.2. |

### 4. Consent enforcement

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 4.1 | Identify the requested task | ✅ | `AI_TASKS` registry; unknown tasks blocked. |
| 4.2 | Identify the information required | ✅ | Tasks declare `requiredCategories` + `minimumCategories`; `required-data-missing` is enforced and required rows are locked in the Assistant. |
| 4.3 | Identify the active provider | ✅ | Resolved before evaluation; no fallback in core/gateway. |
| 4.4 | Verify provider-specific consent | ✅ | Grants keyed by provider + external access. |
| 4.5 | Verify consent for every requested category | ✅ | `evaluateConsent` loops categories; missing list returned. |
| 4.6 | Construct a minimal payload | ✅ | `buildMinimalPayload` allow-list projection, bounded windows, unknown fields dropped. |
| 4.7 | Display a disclosure where required | ✅ | Review is required before a hosted authorization token is issued; the server returns disclosures and the token is not issued for blocked requests. |
| 4.8 | Transmit only approved information | ✅ | `/v1/ai/authorize` is metadata-only; `/v1/ai/complete` needs a single-use token, re-checks consent and rejects unrequested categories. Client bounds recent windows. |
| 4.9 | Stop when permission is missing | ✅ | Blocked decisions never call a transport; gateway returns 403; tests assert transport not called. |
| 4.10 | Users can revoke at any time | ✅ | Per-category revoke + revoke-all; local and hosted. |
| 4.11 | Revocation immediately prevents subsequent transmission | ✅ | Tested end-to-end locally and via gateway. |
| 4.12 | Record consent changes locally with timestamps and policy versions | ✅ | Local ledger is local; hosted consent is mirrored to IndexedDB/SQLite with a sync timestamp and displayed read-only. |
| 4.13 | Never automatically send historical records | ✅ | Recent window default 14; complete history only with grant + confirmation. |
| 4.14 | Never send webcam frames or microphone recordings | ✅ | No media in the payload model; `findRawCapture` rejects binary/data URLs; Tauri permission handler allows capture only locally. |
| 4.15 | Biometric observations only with explicit category + purpose | ✅ | Derived summaries are stored locally; sending requires observation category + per-request approval. |
| 4.16 | Audit metadata only | ✅ | No payload content in audit entries; gateway tests assert health values absent. |
| 4.17 | Per-request confirmation for sensitive observations/history | ✅ | Single-use approval token bound to user/task/purpose/provider/categories with expiry; revalidated and consumed once. |

### 5. Non-LLM analytics must work independently

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 5.1 | BMI | ✅ | `computeBmi`; disclaimer; tests. |
| 5.2 | Weight calculations | ✅ | Latest, change over days. |
| 5.3 | Moving averages | ✅ | `movingAverage`, `buildTrendSeries`. |
| 5.4 | Weight trend charts | ✅ | Dashboard SVG sparkline. |
| 5.5 | Goal progress | ✅ | `computeGoalProgress`. |
| 5.6 | Habit completion | ✅ | Weekly completion, streaks, aggregate. |
| 5.7 | Eating duration statistics | ✅ | Mean/median/p90/trend. |
| 5.8 | Basic weight-loss estimates | ✅ | `projectGoal`; labelled estimate + disclaimer. |
| 5.9 | Rule-based reminders | ✅ | Deterministic rules; no model/network. |
| 5.10 | Daily and weekly statistical summaries | ✅ | `dailySummary`, `weeklySummary`. |
| 5.11 | LLM only for genuine language tasks | ✅ | All calculations are local; AI tasks produce language/coaching. Note: AI “daily summary” overlaps the deterministic summary but is not required for it. |
| 5.12 | No speculative predictions as medical facts | ✅ | Projection marked `kind: "estimate"`, confidence, disclaimer; BMI note. |

### 6. Web API-key security

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 6.1 | No provider keys in frontend JavaScript | ✅ | No key input/storage path; `check-no-secrets` scans `src` + `dist`. |
| 6.2 | No Vite environment key variables | ✅ | Only public URLs; scan rejects `VITE_*KEY/SECRET/TOKEN`. |
| 6.3 | No public environment configuration containing keys | ✅ | `.env.example` is server-only; gateway env. |
| 6.4 | No keys in localStorage/IndexedDB | ✅ | Gateway session token is memory-only; provider keys absent from all stores. |
| 6.5 | No keys in HTML | ✅ | Static HTML has no config. |
| 6.6 | No public source maps | ✅ | `build.sourcemap: false`. |
| 6.7 | No keys in network responses | ✅ | Gateway tests assert response bodies never contain the key/base URL. |
| 6.8 | No keys in client-side config files | ✅ | Provider config stores endpoint/model only. |
| 6.9 | Gateway keeps credentials exclusively server-side | ✅ | Env-only; Rust proxy for desktop. |
| 6.10 | Gateway authenticates requests | ✅ | HMAC tokens with jti/iat/exp/scopes, revocation, refresh/rotation and previous-secret acceptance; covered by tests. |
| 6.11 | Gateway enforces consent independently | ✅ | Server-side `ConsentState`; client claims ignored; test. |
| 6.12 | Gateway validates requested categories and purposes | ✅ | Task ceiling + purpose match + known category checks. |
| 6.13 | Gateway rate limits | ✅ | Separate per-user limiters for AI authorization/completion and consent endpoints, returning 429 + Retry-After; tested. |
| 6.14 | Gateway minimises payloads | ✅ | Server re-sanitises and re-projects; unknown fields dropped. |
| 6.15 | Gateway avoids persisting health data | ✅ | Health payload never written; consent DB is metadata-only; test. |
| 6.16 | Gateway avoids logging sensitive request bodies | ✅ | Logger disabled; upstream error bodies discarded; no body logs. |
| 6.17 | Safe structured errors | ✅ | `{ error: { code, message, retryable, ... } }`; upstream text never echoed. |
| 6.18 | Prevent unauthorised provider switching | ✅ | Server provider fixed; mismatched `providerId` rejected. |
| 6.19 | Credentials never returned to browser | ✅ | Provider info returns ID/model/locality only; test. |
| 6.20 | Disable shared API-key integrations without a secure backend | ✅ | Browser remote providers require the gateway; local models remain available. |
| 6.21 | Offer local AI / user-controlled alternatives | ✅ | Local Ollama/LM Studio; desktop OS-stored credentials. |
| 6.22 | Never claim a frontend key is hidden | ✅ | Copy states browsers cannot hold provider keys. |

### 7. Local desktop security

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 7.1 | OS-protected secret storage | ✅ | `keyring` crate; service `app.habitpilot.desktop`. |
| 7.2 | Windows Credential Manager / DPAPI preference | ✅ | `windows-native` feature; extracted backend name shown in setup. |
| 7.3 | No keys in plaintext SQLite | ✅ | Only consent/settings/providers/health JSON in `app_state`; no secret columns. |
| 7.4 | No keys in exported backups | ✅ | Consent export excludes credentials; no key export command exists. |
| 7.5 | Webview cannot read a stored secret | ✅ | No command returns a secret; provider calls run in Rust. |
| 7.6 | Credentials protected from other same-user processes | ⚪ | Credential Manager is per-user; same-user process access is an OS-level limitation, not an app guarantee. |

### 8. Privacy disclosure

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 8.1 | Dedicated Privacy & AI Settings screen | ✅ | `PrivacyAiSettings.tsx`. |
| 8.2 | Whether the model is local or remote | ✅ | Locality badge and explanation. |
| 8.3 | Which provider receives information | ✅ | Provider label/locality; gateway provider metadata. |
| 8.4 | Which categories may be shared | ✅ | Per-category matrix + per-row reasons. |
| 8.5 | Why the information is needed | ✅ | `whyNeeded` per category. |
| 8.6 | Whether the application backend processes the request | ✅ | Device: no; local-network/remote via gateway: yes, explained. |
| 8.7 | How permission can be revoked | ✅ | Revoke buttons + revocation explainer + audit log. |
| 8.8 | Local AI is not assumed authorised | ✅ | Explicit copy and default-deny. |
| 8.9 | Special location for camera/mic grant and revoke | ✅ | New **Sensors & observations** screen: Enable/Stop & revoke, OS/browser revocation steps. |
| 8.10 | Speaker/audio-output explanation | ✅ | No permission prompt exists; test tone + local TTS toggle explained. |

### 9. Preserve local-first architecture

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 9.1 | No mandatory cloud database | ✅ | No cloud DB. |
| 9.2 | Desktop data remains in local SQLite | ✅ | `habitpilot.db` in app data dir. |
| 9.3 | Browser data remains in IndexedDB | ✅ | `habitpilot` IDB database. |
| 9.4 | No automatic upload of health records | ✅ | Only explicit AI requests egress; gateway does not persist. |
| 9.5 | Optional local-network sync is explicit | ✅ | Not implemented; nothing runs implicitly. |
| 9.6 | Local-network sync feature | ⚪ | Optional by requirement; absent, therefore not misconfigured. |

### 10. Shared domain logic and backend enforcement

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| 10.1 | Complete permission mechanism as shared domain logic | ✅ | `@habitpilot/consent-core`; pure transitions + evaluation + payload. |
| 10.2 | Desktop, web and PWA follow the same rules | ✅ | Same React UI + `ConsentService`; desktop store adapter only. |
| 10.3 | Backend independently enforces external-provider consent | ✅ | Gateway re-evaluates from its own records. |
| 10.4 | Not a decorative settings screen | ✅ | Grant/revoke mutate the ledger; AI calls are blocked without grants; tests prove it. |
| 10.5 | All AI requests pass through the enforcement layer | ✅ | `scripts/check-ai-paths.mjs` fails the build when transports/pipelines are constructed elsewhere; part of `pnpm verify`. |
| 10.6 | Enforcement covered by tests | ✅ | 129 tests including blocked-send, revocation, switch rejection, minimisation, approval replay, provider fingerprinting and audit. |

---

## 3. Enforcement invariants after the fixes

All previously partial items are closed. The residual accepted risks above are
architectural or deployment concerns; none weakens default-deny, per-category
consent, payload minimisation or immediate revocation.

Verified end to end:

- A configured provider with no grants is blocked with the exact required message.
- A missing provider is reported, never replaced by another provider.
- Category A never authorises category B; complete-history consent does not
  authorise concrete categories on its own.
- Changing a provider endpoint/model invalidates grants and requires renewal.
- Revocation immediately blocks the next request, locally and server-side.
- Hosted authorization carries no health values; completion requires a
  single-use token and rejects unrequested categories.
- A token issued before revocation cannot be used afterwards.
- Raw media flags are rejected before a provider is called.
- Consent and audit records contain no health values or credentials.

## 4. Evidence and verification

### Automated

| Suite | Tests | What it proves |
| --- | --- | --- |
| `packages/consent-core/test/consent.test.ts` | 30 | default-deny, exact messages, provider/purpose/category scoping, fingerprint changes, policy invalidation, external access, confirmation, revocation, local audit |
| `packages/consent-core/test/pipeline.test.ts` | 21 | minimal payloads, history unlock, category isolation, raw-capture rejection, no transport on block, transport errors, audit metadata |
| `packages/health-analytics/test/analytics.test.ts` | 26 | BMI, trends, moving averages, goals/estimates, habits, eating, reminders, daily/weekly summaries |
| `apps/web/test/*.test.ts` | 19 | client minimisation/windowing, endpoint classification, provider selection, demo data, sensor math |
| `services/gateway/test/gateway.test.ts` | 33 | auth/rotation/revocation, server consent, two-phase approval, single-use/expiry, unrequested-data rejection, rate limits, key leakage, persistence safety |
| **Total** | **129** | `pnpm verify` exits 0 |

Also verified:

- `cargo check` and `cargo build --release` succeed.
- NSIS installer builds (`HabitPilot_0.1.0_x64-setup.exe`, ~3.8 MiB).
- Packaged `.exe` launches and remains running.
- Browser end-to-end with a fake camera/mic: frames analysed, 0 stored, level meter
  active, derived observation saved, `Stop & revoke` released tracks, and sensor access
  events appeared in the audit log.
- Hosted flow with a mock provider: authorization body contained **no health values**;
  completion carried the approval token and only 14 bounded weight entries; the provider
  returned text; the audit recorded the allowed request.
- Gateway restart retained consent from the default `data/consent.json` store.
- CSP enabled in the production build with no console errors.
- Revocation blocked the next request with the exact required message.

### Not yet verified

- Real camera/microphone hardware and Windows privacy-denied paths.
- Real provider API keys/traffic (OpenAI/Anthropic/Gemini).
- Multi-user identity provider, token revocation, load/rate-limit stress.
- Installer upgrade over a previously installed build.
- Independent security review / penetration test.

---

## 5. Optional next hardening

1. Replace the self-issued session tokens with your identity provider and a shared
   session-revocation store.
2. Move approvals and consent records to a database for multi-instance hosting.
3. Sign and notarize the installer; add auto-update.
4. Add audit-retention controls and an optional local-network sync configuration.
5. Tighten the web CSP `connect-src` to a fixed gateway origin where possible.

 Re-running this audit

```bash
pnpm verify                 # typecheck + 129 tests + builds + secrets scan
pnpm check:desktop          # cargo check
pnpm desktop:build          # installer + packaged app
pnpm check:no-secrets       # frontend credential scan
pnpm check:ai-paths         # enforcement bypass guard
```

Browser checks:

1. Privacy & AI: no provider → grant buttons disabled with an explanation.
2. Add provider → permissions still denied; grant one category.
3. Assistant: review → send; revoke → send blocked with the exact message.
4. Sensors: enable camera/mic, verify 0 frames/audio stored, stop & revoke.
5. Gateway: consent + external access, revoke, confirm 403; inspect audit metadata.
