import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { DATA_CATEGORY_DEFINITIONS, PROVIDER_DEFINITIONS, getProviderDefinition } from "@habitpilot/consent-core";
import { useApp } from "../state/AppProvider.js";
import { Badge, Card } from "../components/ui.js";
import { defaultEndpointFor } from "../lib/localTransport.js";
import { desktopInfo, openDataFolder, type DesktopInfo } from "../lib/desktop.js";
import type { Page } from "../navigation.js";

type Step = 1 | 2 | 3;

export function DesktopSetup({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const {
    desktop,
    providers,
    activeProvider,
    addProvider,
    setActiveProvider,
    connectGateway,
    completeSetup,
    working,
    consentState,
  } = useApp();

  const [step, setStep] = useState<Step>(1);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [localProviderId, setLocalProviderId] = useState<"ollama" | "lmstudio">("ollama");
  const [model, setModel] = useState("llama3.2");
  const [endpoint, setEndpoint] = useState(defaultEndpointFor("ollama"));
  const [gatewayUrl, setGatewayUrl] = useState("http://127.0.0.1:8787");
  const [gatewayToken, setGatewayToken] = useState("");

  useEffect(() => {
    if (!desktop) return;
    void desktopInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [desktop]);

  if (!desktop) {
    return (
      <Card title="Desktop setup" tone="warning">
        <p>This setup screen runs inside the HabitPilot desktop app.</p>
        <p className="muted">
          In the browser build, open <strong>Privacy &amp; AI Settings</strong> instead.
        </p>
        <button type="button" className="button" onClick={() => onNavigate("privacy")}>
          Open Privacy &amp; AI Settings
        </button>
      </Card>
    );
  }

  const run = async (operation: () => Promise<void>, success?: string) => {
    setError(null);
    setMessage(null);
    try {
      await operation();
      if (success) setMessage(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    }
  };

  const saveLocalProvider = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await addProvider({ providerId: localProviderId, model, endpoint });
      await setActiveProvider(localProviderId);
    }, "Local provider saved. No personal data permission was granted.");
  };

  const saveGateway = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await connectGateway(gatewayUrl, gatewayToken);
      setGatewayToken("");
    }, "Gateway connected. Provider credentials stay on the server.");
  };

  const finish = async (next: Page) => {
    await completeSetup();
    onNavigate(next);
  };

  const granted = consentState.grants.filter(
    (grant) => grant.revokedAt === null && grant.policyVersion === consentState.policyVersion,
  ).length;

  return (
    <div className="stack setup-page">
      <header className="page-head">
        <div>
          <h1>Set up HabitPilot Desktop</h1>
          <p className="muted">
            Three short steps. Setup configures where data lives and how AI can run — it never
            grants access to your health data.
          </p>
        </div>
        <button type="button" className="button button--ghost" onClick={() => void finish("dashboard")}>
          Skip for now
        </button>
      </header>

      <ol className="setup-steps" aria-label="Setup progress">
        {(
          [
            [1, "Storage"],
            [2, "AI provider"],
            [3, "Permissions"],
          ] as const
        ).map(([number, label]) => (
          <li
            key={number}
            className={`setup-steps__item ${step === number ? "setup-steps__item--active" : ""} ${
              step > number ? "setup-steps__item--done" : ""
            }`}
          >
            <span className="setup-steps__number">{step > number ? "✓" : number}</span>
            {label}
          </li>
        ))}
      </ol>

      {message && <p className="callout callout--success">{message}</p>}
      {error && <p className="callout callout--danger">{error}</p>}

      {step === 1 && (
        <Card
          title="1. Your data stays on this machine"
          subtitle="HabitPilot Desktop stores health data in local SQLite. There is no cloud database."
          actions={<Badge tone="good">local-first</Badge>}
        >
          <dl className="fact-list">
            <div>
              <dt>App version</dt>
              <dd>
                {info ? `${info.version} · ${info.platform}` : "reading…"}
              </dd>
            </div>
            <div>
              <dt>SQLite data folder</dt>
              <dd>
                <code>{info?.dataDir ?? "…"}</code>
              </dd>
            </div>
            <div>
              <dt>Database file</dt>
              <dd>
                <code>{info?.databasePath ?? "…"}</code>
              </dd>
            </div>
            <div>
              <dt>Provider credentials</dt>
              <dd>
                <Badge tone="good">{info?.credentialBackend ?? "OS secret store"}</Badge>
                <p className="hint">
                  Write-only from the UI. AI requests are made by the native process, so keys never
                  enter the webview, SQLite or backups.
                </p>
              </dd>
            </div>
          </dl>

          <div className="row row--tight">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void run(() => openDataFolder())}
            >
              Open data folder
            </button>
            <button type="button" className="button button--primary" onClick={() => setStep(2)}>
              Next: choose AI
            </button>
          </div>

          <p className="hint">
            Desktop commands are in the menu bar: <strong>Go</strong> for screens (Ctrl+1…4) and{" "}
            <strong>HabitPilot → Open data folder</strong>.
          </p>
        </Card>
      )}

      {step === 2 && (
        <Card
          title="2. Choose how AI runs"
          subtitle="Optional. Local analytics, charts and reminders already work without any provider."
          actions={
            <button type="button" className="button button--ghost" onClick={() => setStep(1)}>
              Back
            </button>
          }
        >
          <div className="setup-grid">
            <form className="setup" onSubmit={saveLocalProvider}>
              <h3>Local model on this device</h3>
              <p className="muted">
                Ollama or LM Studio. No credential, no third-party provider. You still choose which
                categories to approve later.
              </p>
              <label className="field">
                <span>Provider</span>
                <select
                  value={localProviderId}
                  onChange={(event) => {
                    const next = event.target.value as "ollama" | "lmstudio";
                    setLocalProviderId(next);
                    setEndpoint(defaultEndpointFor(next));
                    setModel(next === "lmstudio" ? "local-model" : "llama3.2");
                  }}
                >
                  {PROVIDER_DEFINITIONS.filter(
                    (entry) => entry.id === "ollama" || entry.id === "lmstudio",
                  ).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <input value={model} onChange={(event) => setModel(event.target.value)} />
              </label>
              <label className="field">
                <span>Endpoint</span>
                <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />
              </label>
              <button type="submit" className="button" disabled={working}>
                Save local provider
              </button>
            </form>

            <form className="setup" onSubmit={saveGateway}>
              <h3>Secure gateway (remote providers)</h3>
              <p className="muted">
                Required for OpenAI, Anthropic, Gemini and DeepSeek in the browser flow. The gateway
                holds the key, authenticates requests and enforces consent again.
              </p>
              <label className="field">
                <span>Gateway URL</span>
                <input
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder="http://127.0.0.1:8787"
                />
              </label>
              <label className="field">
                <span>Session token (memory only)</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={gatewayToken}
                  onChange={(event) => setGatewayToken(event.target.value)}
                />
              </label>
              <button type="submit" className="button" disabled={working}>
                Connect gateway
              </button>
            </form>
          </div>

          <div className="callout callout--warning" style={{ marginTop: "0.9rem" }}>
            <strong>Configuring a provider is not consent.</strong> Even a model running on this
            machine gets no health data until you grant each category separately.
          </div>

          <div className="row" style={{ marginTop: "0.9rem" }}>
            <p className="muted">
              {activeProvider
                ? `Active: ${getProviderDefinition(activeProvider.providerId).label} (${activeProvider.locality}).`
                : "No provider configured yet — that is fine."}
            </p>
            <button type="button" className="button button--primary" onClick={() => setStep(3)}>
              Next: permissions
            </button>
          </div>
          <p className="hint">{providers.length} provider(s) configured.</p>
        </Card>
      )}

      {step === 3 && (
        <Card
          title="3. Permissions start empty"
          subtitle={`All ${DATA_CATEGORY_DEFINITIONS.length} data categories are denied until you approve them individually.`}
          actions={
            <button type="button" className="button button--ghost" onClick={() => setStep(2)}>
              Back
            </button>
          }
        >
          <div className="callout">
            <strong>{granted} active grant{granted === 1 ? "" : "s"}.</strong>
            <p className="muted">
              Off is the default because HabitPilot cannot know which categories you consider safe
              to share, and it never infers permission from having a provider. Each permission is
              scoped to one category, one provider, one purpose and the current consent policy
              version. Sensitive observations and complete history also need approval for every
              send.
            </p>
          </div>

          <ul className="plain-list" style={{ marginTop: "0.8rem" }}>
            <li>Configured provider ≠ permission to read data.</li>
            <li>A local model is not automatically authorized.</li>
            <li>Revoking a category blocks the next request immediately.</li>
            <li>Raw camera, microphone and biometric captures are never sent.</li>
            <li>
              Camera and microphone access is requested separately in Sensors &amp; observations,
              and only text summaries can be saved locally.
            </li>
          </ul>

          <div className="row row--tight" style={{ marginTop: "1rem" }}>
            <button type="button" className="button button--primary" onClick={() => void finish("dashboard")}>
              Finish setup
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                void completeSetup();
                onNavigate("privacy");
              }}
            >
              Open Privacy &amp; AI Settings
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
