import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  DATA_CATEGORY_DEFINITIONS,
  MESSAGES,
  PROVIDER_DEFINITIONS,
  PURPOSE_DEFINITIONS,
  getConsentStatus,
  getProviderDefinition,
  isExternalAccessEnabled,
  type DataCategory,
  type ProviderId,
  type PurposeId,
} from "@habitpilot/consent-core";
import { useApp } from "../state/AppProvider.js";
import { Badge, Card, CategoryBadge, Toggle } from "../components/ui.js";
import { defaultEndpointFor } from "../lib/localTransport.js";
import { defaultRemoteEndpoint } from "../lib/desktop.js";
import type { Page } from "../navigation.js";

const STATUS_TONE = {
  granted: "good",
  "not-granted": "neutral",
  "policy-outdated": "warn",
  "provider-changed": "warn",
  revoked: "bad",
} as const;

const STATUS_LABEL = {
  granted: "Granted",
  "not-granted": "Not granted",
  "policy-outdated": "Needs renewal",
  "provider-changed": "Provider changed",
  revoked: "Revoked",
} as const;

export function PrivacyAiSettings({
  onNavigate,
}: {
  onNavigate: (page: Page) => void;
}): ReactNode {
  const {
    providers,
    activeProvider,
    activeProviderFingerprint,
    consentState,
    hosted,
    gatewayUrl,
    gatewayConnected,
    gatewayInfo,
    gatewayError,
    consentMirrorSyncedAt,
    working,
    desktop,
    credentialBackendName,
    grantConsent,
    revokeConsent,
    revokeAllConsent,
    setExternalAccess,
    addProvider,
    removeProvider,
    setActiveProvider,
    connectGateway,
    refreshGateway,
    disconnectGateway,
    secretStatus,
    storeSecret,
    deleteSecret,
  } = useApp();

  const [purpose, setPurpose] = useState<PurposeId>("daily-coaching");
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [localProviderId, setLocalProviderId] = useState<ProviderId>("ollama");
  const [model, setModel] = useState("llama3.2");
  const [endpoint, setEndpoint] = useState(defaultEndpointFor("ollama"));

  const [gatewayFormUrl, setGatewayFormUrl] = useState(gatewayUrl || "http://127.0.0.1:8787");
  const [gatewayToken, setGatewayToken] = useState("");

  const [desktopProviderId, setDesktopProviderId] = useState<ProviderId>("openai");
  const [desktopModel, setDesktopModel] = useState("gpt-5-mini");
  const [desktopEndpoint, setDesktopEndpoint] = useState(defaultRemoteEndpoint("openai"));
  const [desktopSecret, setDesktopSecret] = useState("");
  const [secretPresent, setSecretPresent] = useState<boolean | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void secretStatus(desktopProviderId)
      .then((present) => {
        if (!cancelled) setSecretPresent(present);
      })
      .catch(() => {
        if (!cancelled) setSecretPresent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, desktopProviderId, secretStatus]);

  const cannotMutateRemote = hosted && !gatewayConnected;
  const actionsDisabled = working || !activeProvider || cannotMutateRemote;
  const externalAccessOn = activeProvider
    ? isExternalAccessEnabled(consentState, activeProvider.providerId)
    : false;

  const activeFingerprint = activeProviderFingerprint ?? undefined;

  const activeGrantCount = activeProvider
    ? DATA_CATEGORY_DEFINITIONS.filter(
        (definition) =>
          getConsentStatus(
            consentState,
            definition.id,
            activeProvider.providerId,
            purpose,
            activeFingerprint,
          ).status === "granted",
      ).length
    : 0;

  const outdatedCount = activeProvider
    ? DATA_CATEGORY_DEFINITIONS.filter(
        (definition) =>
          getConsentStatus(
            consentState,
            definition.id,
            activeProvider.providerId,
            purpose,
            activeFingerprint,
          ).status === "policy-outdated",
      ).length
    : 0;

  const changedCount = activeProvider
    ? DATA_CATEGORY_DEFINITIONS.filter(
        (definition) =>
          getConsentStatus(
            consentState,
            definition.id,
            activeProvider.providerId,
            purpose,
            activeFingerprint,
          ).status === "provider-changed",
      ).length
    : 0;

  const run = async (operation: () => Promise<void>, success?: string) => {
    setActionError(null);
    setMessage(null);
    try {
      await operation();
      if (success) setMessage(success);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The action could not be completed.");
    }
  };

  const submitLocalProvider = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await addProvider({ providerId: localProviderId, model, endpoint });
      setMessage(
        "Provider configured. No personal data permission was granted — choose categories below.",
      );
    });
  };

  const submitGateway = async (event: FormEvent) => {
    event.preventDefault();
    await run(
      async () => {
        await connectGateway(gatewayFormUrl, gatewayToken);
        setGatewayToken("");
      },
      "Secure gateway connected. Remote provider credentials stay on the server.",
    );
  };

  const reconnect = async () => {
    await run(
      async () => {
        await refreshGateway(gatewayToken || undefined);
        setGatewayToken("");
      },
      "Gateway consent state refreshed.",
    );
  };

  const changeDesktopProvider = (next: ProviderId) => {
    setDesktopProviderId(next);
    const models: Partial<Record<ProviderId, string>> = {
      openai: "gpt-5-mini",
      anthropic: "claude-sonnet-4-5",
      gemini: "gemini-2.5-pro",
      deepseek: "deepseek-chat",
      "openai-compatible": "local-model",
      ollama: "llama3.2",
      lmstudio: "local-model",
    };
    setDesktopModel(models[next] ?? "");
    setDesktopEndpoint(defaultRemoteEndpoint(next) || defaultEndpointFor(next));
  };

  const submitDesktopProvider = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await addProvider(
        { providerId: desktopProviderId, model: desktopModel, endpoint: desktopEndpoint },
        { remote: true },
      );
      setMessage(
        "Desktop provider saved. No personal data permission was granted and no credential was shared with the webview.",
      );
    });
  };

  const saveDesktopCredential = async () => {
    await run(async () => {
      if (!desktopSecret.trim()) throw new Error("Enter a credential to store.");
      await storeSecret(desktopProviderId, desktopSecret);
      setDesktopSecret("");
      setSecretPresent(true);
      setMessage("Credential stored by the operating system. It is never returned to the app UI.");
    });
  };

  const removeDesktopCredential = async () => {
    await run(async () => {
      await deleteSecret(desktopProviderId);
      setSecretPresent(false);
      setMessage("Credential removed from the OS secret store.");
    });
  };

  const exportConsent = () => {
    const record = {
      exportedAt: new Date().toISOString(),
      policyVersion: consentState.policyVersion,
      grants: consentState.grants,
      externalAccess: consentState.externalAccess,
      auditLog: consentState.auditLog,
      note: "Consent metadata only. Contains no health records and no provider credentials.",
    };
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "habitpilot-consent-record.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const grant = (category: DataCategory) =>
    run(
      () => grantConsent(category, purpose),
      "Permission granted with a timestamp and the current policy version.",
    );

  const jumpToProviders = () => {
    document
      .getElementById("ai-providers")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const grantDisabledReason = !activeProvider
    ? "No AI provider is configured. Permissions start disabled and cannot be granted without one."
    : cannotMutateRemote
      ? "Reconnect the secure gateway to manage server-side consent."
      : undefined;

  const providerLabel = activeProvider
    ? getProviderDefinition(activeProvider.providerId).label
    : null;
  const purposeLabel =
    PURPOSE_DEFINITIONS.find((entry) => entry.id === purpose)?.label ?? purpose;

  const revoke = (category: DataCategory) =>
    run(
      () => revokeConsent(category, purpose),
      "Permission revoked. Future requests stop immediately.",
    );

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Privacy &amp; AI Settings</h1>
          <p className="muted">
            Provider configuration, data-sharing permission and external access are three separate
            states. None of them turns on another.
          </p>
        </div>
        <Badge tone="info">Policy {consentState.policyVersion}</Badge>
      </header>

      {message && <p className="callout callout--success">{message}</p>}
      {actionError && <p className="callout callout--danger">{actionError}</p>}

      <div className="callout">
        <strong>All data-sharing permissions start disabled. This is intentional.</strong>
        <p className="muted">
          HabitPilot grants nothing by default. Adding a provider, storing a credential or running a
          local model does not change that. A permission applies only to one data category, one
          provider, one purpose and the current consent policy version — and you can revoke it at
          any time.
        </p>
      </div>

      <div className="callout">
        <strong>Camera and microphone access lives in Sensors &amp; observations.</strong>
        <p className="muted">
          Device capture is separate from AI data-sharing consent. Granting a camera does not
          authorize an AI provider; observation categories below still need their own permission and
          per-request approval.
        </p>
        <button type="button" className="button" onClick={() => onNavigate("sensors")}>
          Open Sensors &amp; observations
        </button>
      </div>

      {(outdatedCount > 0 || changedCount > 0) && (
        <p className="callout callout--warning">
          {outdatedCount} permission{outdatedCount === 1 ? "" : "s"} need renewal for the current
          policy and {changedCount} for a changed provider configuration. Renew them before using AI
          with those categories.
        </p>
      )}
      {!activeProvider && (
        <p className="callout callout--warning">
          {MESSAGES.noProvider} Local analytics and reminders keep working without one.
        </p>
      )}

      <div id="ai-providers" className="anchor-target" />
      <Card
        title="AI providers"
        subtitle="Configuring a provider does not grant permission to read any personal data."
      >
        {providers.length === 0 ? (
          <p className="muted">No provider is configured yet.</p>
        ) : (
          <ul className="provider-list">
            {providers.map((provider) => {
              const definition = getProviderDefinition(provider.providerId);
              const isActive = activeProvider?.providerId === provider.providerId;
              return (
                <li key={provider.providerId} className={isActive ? "provider--active" : ""}>
                  <label className="provider-row">
                    <input
                      type="radio"
                      name="active-provider"
                      checked={isActive}
                      onChange={() => void run(() => setActiveProvider(provider.providerId))}
                    />
                    <span>
                      <span className="row row--tight">
                        <strong>{definition.label}</strong>
                        <Badge tone={provider.locality === "device" ? "good" : provider.locality === "local-network" ? "warn" : "bad"}>
                          {provider.locality}
                        </Badge>
                        {isActive && <Badge tone="info">active</Badge>}
                      </span>
                      <span className="muted">
                        model {provider.model}
                        {provider.endpoint ? ` · ${provider.endpoint}` : ""}
                      </span>
                    </span>
                  </label>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => void run(() => removeProvider(provider.providerId))}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="setup-grid">
          <form className="setup" onSubmit={submitLocalProvider}>
            <h3>Add an on-device / local-network model</h3>
            <p className="muted">
              No provider credential is used. Requests go directly from this app to the endpoint you
              enter.
            </p>
            <label className="field">
              <span>Provider</span>
              <select
                value={localProviderId}
                onChange={(event) => {
                  const next = event.target.value as ProviderId;
                  setLocalProviderId(next);
                  setEndpoint(defaultEndpointFor(next));
                  setModel(next === "lmstudio" ? "local-model" : "llama3.2");
                }}
              >
                {PROVIDER_DEFINITIONS.filter((definition) => definition.deviceCallable).map(
                  (definition) => (
                    <option key={definition.id} value={definition.id}>
                      {definition.label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label className="field">
              <span>Endpoint</span>
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="http://127.0.0.1:11434"
              />
            </label>
            <button type="submit" className="button" disabled={working}>
              Save provider
            </button>
            <p className="hint">
              Browsers cannot hold provider API keys. If your endpoint needs a key, use the desktop
              app (OS secret storage) or the hosted gateway.
            </p>
          </form>

          <form className="setup" onSubmit={submitGateway}>
            <h3>Connect the secure gateway</h3>
            <p className="muted">
              Required for OpenAI, Anthropic, Gemini, DeepSeek and other remote providers. Provider
              API keys stay on the server and are never returned to this browser.
            </p>
            <label className="field">
              <span>Gateway URL</span>
              <input
                value={gatewayFormUrl}
                onChange={(event) => setGatewayFormUrl(event.target.value)}
                placeholder="https://gateway.example.com"
              />
            </label>
            <label className="field">
              <span>Session token (memory only)</span>
              <input
                type="password"
                autoComplete="off"
                value={gatewayToken}
                onChange={(event) => setGatewayToken(event.target.value)}
                placeholder={gatewayConnected ? "Connected — paste a new token to refresh" : "Paste your gateway token"}
              />
            </label>
            <div className="row row--tight">
              <button type="submit" className="button" disabled={working}>
                {gatewayConnected ? "Reconnect" : "Connect"}
              </button>
              {gatewayUrl && (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void run(() => reconnect())}
                  disabled={working}
                >
                  Refresh consent state
                </button>
              )}
              {gatewayConnected && (
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void run(() => disconnectGateway())}
                >
                  Disconnect
                </button>
              )}
            </div>
            {gatewayConnected && gatewayInfo && (
              <p className="hint">
                Connected to {gatewayUrl}. Server-side provider:{" "}
                {gatewayInfo.providerId} ({gatewayInfo.locality}), model {gatewayInfo.model}. The
                gateway enforces consent independently of this screen.
              </p>
            )}
            {gatewayError && <p className="callout callout--danger">{gatewayError}</p>}
            <p className="hint">
              The session token is kept in memory only. It is never written to IndexedDB,
              localStorage or a URL.
            </p>
          </form>
        </div>
      </Card>

      {desktop && (
        <Card
          title="Desktop credentials (operating-system protected)"
          subtitle="Provider credentials are stored by the OS secret store and used only by the native process."
          tone="warning"
        >
          <p className="muted">
            Backend: <code>{credentialBackendName ?? "operating-system secret store"}</code>. On
            Windows this is Credential Manager, protected with DPAPI. Keys are never written to
            SQLite, exported backups, browser storage or this UI, and no command can read a stored
            key back.
          </p>
          <form className="setup" onSubmit={submitDesktopProvider}>
            <label className="field">
              <span>Provider</span>
              <select
                value={desktopProviderId}
                onChange={(event) => changeDesktopProvider(event.target.value as ProviderId)}
              >
                {PROVIDER_DEFINITIONS.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model</span>
              <input value={desktopModel} onChange={(event) => setDesktopModel(event.target.value)} />
            </label>
            <label className="field">
              <span>Endpoint</span>
              <input
                value={desktopEndpoint}
                onChange={(event) => setDesktopEndpoint(event.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>

            <div className="row row--tight">
              <Badge tone={secretPresent ? "good" : "neutral"}>
                {secretPresent === null
                  ? "credential status unavailable"
                  : secretPresent
                    ? "credential stored"
                    : "no credential stored"}
              </Badge>
            </div>
            <label className="field">
              <span>Store or replace credential</span>
              <input
                type="password"
                autoComplete="off"
                value={desktopSecret}
                onChange={(event) => setDesktopSecret(event.target.value)}
                placeholder="Write-only: the app cannot read it back"
              />
            </label>

            <div className="row row--tight">
              <button type="submit" className="button" disabled={working}>
                Save provider
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void saveDesktopCredential()}
                disabled={working}
              >
                Store credential
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void removeDesktopCredential()}
                disabled={working || !secretPresent}
              >
                Delete credential
              </button>
            </div>
            <p className="hint">
              Storing a credential does not grant data access. Remote requests still need
              per-category consent and external access enabled below.
            </p>
          </form>
        </Card>
      )}

      <Card
        title="Where the model runs"
        subtitle="Locality is descriptive, not a permission. A local model still needs explicit consent."
      >
        {activeProvider ? (
          <div className="stack stack--tight">
            <div className="row">
              <Badge tone={activeProvider.locality === "device" ? "good" : "warn"}>
                {activeProvider.locality}
              </Badge>
              <strong>{getProviderDefinition(activeProvider.providerId).label}</strong>
            </div>
            <p className="muted">
              {activeProvider.locality === "device"
                ? "Inference happens on this device. HabitPilot's backend does not process the request."
                : activeProvider.locality === "local-network"
                  ? hosted
                    ? "Inference happens on an endpoint on your local network. The HabitPilot gateway relays the request, enforces consent server-side and does not store the body."
                    : "Inference happens on an endpoint on your local network. HabitPilot's hosted backend does not process the request."
                  : "Inference happens at a remote third-party provider. The HabitPilot gateway processes and relays the request, then discards it."}
            </p>
          </div>
        ) : (
          <p className="muted">No provider selected.</p>
        )}
      </Card>

      {activeProvider && activeProvider.locality !== "device" && (
        <Card
          title="External provider access"
          tone="warning"
          subtitle="A separate switch. It does not grant any data category."
        >
          <div className="row">
            <div>
              <strong>{externalAccessOn ? "External access is enabled" : "External access is disabled"}</strong>
              <p className="muted">
                {activeProvider.locality === "local-network"
                  ? "Required before approved data can leave this device for a local-network endpoint."
                  : "Required before approved data can leave your device for a remote provider."}
              </p>
            </div>
            <Toggle
              label="External provider access"
              checked={externalAccessOn}
              disabled={actionsDisabled}
              onChange={(next) =>
                void run(
                  () => setExternalAccess(next),
                  next ? "External access enabled. Category permissions are unchanged." : "External access disabled.",
                )
              }
            />
          </div>
          {hosted && (
            <p className="hint">
              For hosted providers this switch is stored and enforced on the server.
            </p>
          )}
        </Card>
      )}

      <Card
        title="Data-sharing permission"
        subtitle="Off by default. Each category is granted separately, for one provider and one purpose. Grants are never implied."
        actions={
          <div className="row row--tight">
            <button type="button" className="button button--ghost" onClick={exportConsent}>
              Export consent record
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={actionsDisabled}
              title={grantDisabledReason}
              onClick={() =>
                void run(() => revokeAllConsent(), "All data-sharing permissions revoked.")
              }
            >
              Revoke all
            </button>
          </div>
        }
      >
        <div className="consent-toolbar">
          <label className="field field--inline">
            <span>Purpose</span>
            <select value={purpose} onChange={(event) => setPurpose(event.target.value as PurposeId)}>
              {PURPOSE_DEFINITIONS.map((definition) => (
                <option key={definition.id} value={definition.id}>
                  {definition.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            {activeProvider
              ? `${activeGrantCount} of ${DATA_CATEGORY_DEFINITIONS.length} categories granted`
              : "No provider selected — permissions cannot be granted yet"}
          </span>
        </div>
        <p className="hint">{PURPOSE_DEFINITIONS.find((entry) => entry.id === purpose)?.description}</p>

        {activeProvider ? (
          <p className="consent-context">
            Managing permissions for <strong>{providerLabel}</strong> ({activeProvider.locality}) ·
            purpose <strong>{purposeLabel}</strong> · policy{" "}
            <code>{consentState.policyVersion}</code>
          </p>
        ) : (
          <div className="callout callout--warning">
            <strong>Grant buttons are disabled because no AI provider is configured.</strong>
            <p className="muted">
              Every permission starts off, and there is nothing to attach a permission to until a
              provider exists. Configure a local model or the secure gateway above, then choose the
              categories this provider may use.
            </p>
            <button type="button" className="button" onClick={jumpToProviders}>
              Configure a provider
            </button>
          </div>
        )}

        {cannotMutateRemote && (
          <p className="callout callout--warning">
            Grant buttons are disabled because the secure gateway is not connected. Remote consent
            is enforced and stored on the server, so reconnect the gateway to manage it.
          </p>
        )}

        {activeProvider && !cannotMutateRemote && (
          <p className="hint">
            Each row below is a separate permission. Nothing is shared until you press Grant, and a
            grant covers only this provider and purpose.
          </p>
        )}

        <ul className="consent-list">
          {DATA_CATEGORY_DEFINITIONS.map((definition) => {
            const status = activeProvider
              ? getConsentStatus(
                  consentState,
                  definition.id,
                  activeProvider.providerId,
                  purpose,
                  activeFingerprint,
                )
              : null;
            const statusValue = status?.status ?? "not-granted";
            const grantRecord = status?.grant ?? null;
            return (
              <li key={definition.id} className="consent-item">
                <div className="consent-item__main">
                  <div className="row row--tight">
                    <strong>{definition.label}</strong>
                    <CategoryBadge category={definition.id} />
                    <Badge tone={STATUS_TONE[statusValue]}>{STATUS_LABEL[statusValue]}</Badge>
                    {definition.requiresExplicitConfirmation && (
                      <Badge tone="warn">per-request approval</Badge>
                    )}
                  </div>
                  <p className="muted">{definition.summary}</p>
                  <p className="hint">Why: {definition.whyNeeded}</p>
                  {statusValue === "not-granted" && (
                    <p className="consent-reason">
                      Off by default.{" "}
                      {activeProvider
                        ? `No permission has been granted for ${providerLabel} and the "${purposeLabel}" purpose.`
                        : "Configure a provider before this category can be granted."}
                    </p>
                  )}
                  {statusValue === "revoked" && (
                    <p className="consent-reason">
                      Revoked. You can grant it again for this provider and purpose.
                    </p>
                  )}
                  {statusValue === "policy-outdated" && (
                    <p className="consent-reason">
                      Granted under policy {grantRecord?.policyVersion ?? "unknown"}. Renew to approve
                      it under the current consent policy.
                    </p>
                  )}
                  {statusValue === "provider-changed" && (
                    <p className="consent-reason">
                      The provider endpoint, model or locality changed since this permission was
                      approved. Renew it for the current configuration.
                    </p>
                  )}
                  {grantRecord && (
                    <p className="hint">
                      Granted {new Date(grantRecord.grantedAt).toLocaleString()} · policy{" "}
                      {grantRecord.policyVersion}
                      {grantRecord.revokedAt
                        ? ` · revoked ${new Date(grantRecord.revokedAt).toLocaleString()}`
                        : ""}
                    </p>
                  )}
                </div>
                <div className="consent-item__actions">
                  {statusValue === "granted" ? (
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      disabled={working}
                      onClick={() => void revoke(definition.id)}
                    >
                      Revoke
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button--small"
                      disabled={actionsDisabled}
                      title={grantDisabledReason}
                      onClick={() => void grant(definition.id)}
                    >
                      {statusValue === "policy-outdated" || statusValue === "provider-changed"
                        ? "Renew"
                        : "Grant"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="How revocation works" subtitle="Consent changes are recorded locally with timestamps.">
        <ul className="plain-list">
          <li>Revoking a category stops the next request immediately; no retry is attempted.</li>
          <li>
            {hosted
              ? "For hosted providers, revocations are written to the gateway and enforced there before any transmission."
              : "This provider is called directly from the app, so the local consent record is checked before every transmission."}
          </li>
          <li>Complete history and sensitive observations need approval for each individual send.</li>
          {hosted && consentMirrorSyncedAt && (
            <li>
              A read-only copy of the gateway consent record is stored locally (last synced{" "}
              {new Date(consentMirrorSyncedAt).toLocaleString()}).
            </li>
          )}
          <li>Exported consent records contain metadata only: no health records and no credentials.</li>
          <li>
            <button type="button" className="link-button" onClick={() => onNavigate("audit")}>
              View the full consent audit log
            </button>
          </li>
        </ul>
      </Card>
    </div>
  );
}
