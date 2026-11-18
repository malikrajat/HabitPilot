# Threat model

Scope: HabitPilot web/PWA, desktop shell, hosted gateway, and the consent domain
that ties them together. The primary assets are personal health records, provider
credentials and consent decisions.

## Assets

| Asset | Location | Notes |
| --- | --- | --- |
| Health records | Browser IndexedDB / desktop SQLite | Never uploaded automatically |
| Consent ledger | Same local store / gateway store | Metadata only |
| Provider API keys | Gateway env / OS secret store | Never in browser, SQLite or backups |
| Gateway session tokens | Browser memory | Not persisted |
| AI request payloads | In flight only | Bounded, minimized, not logged or stored |

## Trust boundaries

1. **Browser UI** — untrusted for authorization. It can be modified by the user
   or an extension. Enforcement therefore also happens in the gateway, and local
   requests go through the shared pipeline rather than raw `fetch` calls.
2. **Desktop webview** — same as browser for authorization, but credentials are
   outside its reach entirely (Rust process).
3. **Gateway** — trusted for authorization and credential custody. It trusts only
   its own consent store, not client-supplied flags.
4. **AI provider** — untrusted recipient. Receives only approved categories, only
   after a current grant and (for non-device endpoints) external access.

## Threats and mitigations

### T1. Consent bypass by modifying the frontend

- Gateway re-runs `evaluateConsent` with server records.
- Client booleans such as `consentGranted: true` are ignored (tested).
- Provider selection is server-side; a mismatched `providerId` is rejected.

### T2. Silent provider fallback / provider switching

- `resolveActiveProvider` returns `null` when a named provider is not configured.
- Gateway rejects any provider declaration that differs from its configuration.
- No retry to a different provider exists anywhere.

### T3. Over-broad payloads

- Category projection is allow-list based; unknown fields are dropped.
- Record windows are capped in recent mode.
- `history.complete` does not authorize concrete categories by itself.
- Gateway sanitizes again (bounded arrays, known fields).
- Raw capture guard rejects binary/media values and capture-named keys.

### T4. Consent granted once, used forever

- Grants embed `policyVersion`; changing the policy invalidates them.
- Every grant is scoped to one `(category, provider, purpose)`.
- Revocation is immediate for subsequent requests (tested end-to-end).
- Sensitive categories and complete history require per-request confirmation.

### T5. Credential exposure in the browser

- No provider-key input or storage exists in the web app.
- Vite variables are public; the app only reads a public gateway URL.
- `check:no-secrets` scans source and build output for key patterns and
  `VITE_*KEY/SECRET/TOKEN` usage.
- Hosted mode keeps provider keys exclusively in gateway env.
- Desktop mode stores keys in Windows Credential Manager/DPAPI and uses them in
  Rust; no IPC command returns the secret.

### T6. Sensitive data in logs / persistence

- Gateway logging is off by default; no request bodies are logged.
- Upstream provider error bodies are discarded.
- Audit entries are metadata-only by construction.
- Gateway consent persistence contains grants and audit metadata, never health
  payloads (tested).
- Consent export excludes health records and credentials.

### T7. Abuse of the gateway

- Bearer token verification with constant-time comparison and expiry.
- Per-user fixed-window rate limit with `Retry-After`.
- Body size limit (256 KiB).
- Explicit CORS allow-list.
- `Cache-Control: no-store`, `nosniff`, `no-referrer` on all responses.
- Provider timeouts (30 s) to bound resource use.

### T8. Raw sensor capture leaking

- Captures start only from an explicit button press in **Sensors &
  observations**; there is no background capture.
- Camera frames are downscaled to 64×48 in memory, compared for movement, then
  discarded. No frame is written to disk or IndexedDB/SQLite.
- Microphone input is analysed for RMS level only. There is no `MediaRecorder`,
  buffer retention or audio file.
- Derived text can be stored locally, but sending it to AI still requires the
  observation category grant and per-request confirmation.
- `containsRawMedia` blocks the request outright, and `findRawCapture` rejects
  binary values, Blobs, data URLs and media-named keys.
- Tauri's trusted-origin permission handler allows only camera and microphone
  for the app origin; every other webview permission and origin is denied.
- Stopping or leaving the screen stops all tracks and closes the audio context.

Device-level grants remain under OS/browser control, and the UI documents where
to revoke them (Windows privacy settings, browser site settings).

### T9. Consent state divergence between UI and server

- Hosted UI treats the gateway as the source of truth and displays server records.
- If the gateway is unreachable, remote AI is disabled rather than falling back
  to a local model or a client-only check.
- The web app never silently reuses a local grant for a remote provider.

### T10. Local data theft

- Local-first storage is not encrypted at rest in this slice. OS disk encryption
  and desktop account security are the assumed controls.
- Credentials are separated from the database and protected by the OS secret store.
- No health data is uploaded automatically; the only egress paths are explicit
  AI requests and (optional, not implemented here) local-network sync.

## Residual risks

| Risk | Notes |
| --- | --- |
| Client-asserted per-request confirmation | A compromised client can set `confirmed: true`. Mitigation: short-lived, single-use approval tokens issued by a preview endpoint (recommended next step). |
| Demo token issuance | HMAC bearer tokens are a stand-in for an identity provider. |
| Prompt injection via stored text | Observation summaries are user/device-derived text. The system prompt limits scope, but the model may still be influenced. Keep prompts free of instructions from records and never treat model output as a command. |
| Provider-side retention | Once approved data is sent, the provider's terms apply. The UI discloses this and limits payloads. |
| No at-rest encryption in IndexedDB/SQLite | Relies on device/OS controls; SQLCipher/DPAPI-wrapped keys are a future enhancement. |
| Extension-based browser attacks | Cannot be fully mitigated in a web app; desktop mode reduces the attack surface and removes credential reachability. |

## Verification

Security-relevant behaviors are covered by tests:

- default-deny and exact messages;
- category/provider/purpose scoping;
- policy-version invalidation;
- external-access separation;
- confirmation requirement;
- revocation immediately stopping transmission;
- gateway independence from client claims;
- provider-switch rejection;
- payload minimization and secret absence;
- metadata-only audit and persistence;
- rate limiting and CORS.
