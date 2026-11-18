import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "./state/AppProvider.js";
import { Dashboard } from "./screens/Dashboard.js";
import { Assistant } from "./screens/Assistant.js";
import { Sensors } from "./screens/Sensors.js";
import { PrivacyAiSettings } from "./screens/PrivacyAiSettings.js";
import { AuditLog } from "./screens/AuditLog.js";
import { DesktopSetup } from "./screens/DesktopSetup.js";
import { PAGE_TITLES, isPage, type Page } from "./navigation.js";
import { Badge } from "./components/ui.js";

function readPage(): Page {
  const hash = window.location.hash.replace("#", "");
  return isPage(hash) ? hash : "dashboard";
}

const NAV: readonly { page: Page; label: string; hint: string }[] = [
  { page: "dashboard", label: "Dashboard", hint: "Local analytics" },
  { page: "assistant", label: "AI Assistant", hint: "Consent-gated" },
  { page: "sensors", label: "Sensors", hint: "Camera & mic" },
  { page: "privacy", label: "Privacy & AI", hint: "Permissions" },
  { page: "audit", label: "Consent log", hint: "History" },
];

export function App(): ReactNode {
  const {
    ready,
    loadError,
    activeProvider,
    consentState,
    activeProviderFingerprint,
    providers,
    hosted,
    gatewayConnected,
    desktop,
    setupComplete,
  } = useApp();
  const [page, setPage] = useState<Page>(readPage);
  const setupRedirected = useRef(false);

  useEffect(() => {
    const onHashChange = () => setPage(readPage());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!desktop || !ready || setupComplete || setupRedirected.current) return;
    setupRedirected.current = true;
    window.location.hash = "setup";
    setPage("setup");
  }, [desktop, ready, setupComplete]);

  // Native menu commands (Go → Dashboard/AI/Privacy/Consent log/Setup).
  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<string>("habitpilot:navigate", (event) => {
          if (isPage(event.payload)) {
            window.location.hash = event.payload;
            setPage(event.payload);
          }
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // Running outside the Tauri shell.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [desktop]);

  const navigate = (next: Page) => {
    window.location.hash = next;
    setPage(next);
  };

  if (!ready) {
    return (
      <div className="splash">
        <img className="splash__logo" src="/logo.svg" alt="" width={64} height={64} />
        <p>Opening your local HabitPilot database…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="splash">
        <h1>HabitPilot could not start</h1>
        <p>{loadError}</p>
        <p className="muted">
          Local storage may be blocked in this browser context. Nothing was uploaded.
        </p>
      </div>
    );
  }

  const granted = activeProvider
    ? consentState.grants.filter(
        (grant) =>
          grant.providerId === activeProvider.providerId &&
          grant.providerFingerprint === activeProviderFingerprint &&
          grant.revokedAt === null &&
          grant.policyVersion === consentState.policyVersion,
      ).length
    : 0;

  const navItems = desktop
    ? [
        ...NAV,
        {
          page: "setup" as const,
          label: "Setup",
          hint: setupComplete ? "Configuration" : "Action needed",
        },
      ]
    : NAV;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand__mark" src="/logo.svg" alt="" width={38} height={38} />
          <div>
            <strong>HabitPilot</strong>
            <span className="brand__tag">{desktop ? "Desktop" : "Local-first"}</span>
          </div>
        </div>

        <nav className="nav" aria-label="Primary">
          {navItems.map((item) => (
            <button
              key={item.page}
              type="button"
              className={`nav__item ${page === item.page ? "nav__item--active" : ""}`}
              onClick={() => navigate(item.page)}
              aria-current={page === item.page ? "page" : undefined}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>

        <div className="sidebar__footer">
          <p className="sidebar__label">AI status</p>
          {activeProvider ? (
            <>
              <Badge tone={activeProvider.locality === "device" ? "good" : "warn"}>
                {activeProvider.locality}
              </Badge>
              <p className="muted">
                {activeProvider.providerId} · {activeProvider.model}
              </p>
              <p className="hint">
                {granted} active grant{granted === 1 ? "" : "s"}
                {hosted
                  ? gatewayConnected
                    ? " · gateway verified"
                    : " · gateway not connected"
                  : ""}
              </p>
            </>
          ) : (
            <>
              <Badge tone="neutral">not configured</Badge>
              <p className="hint">Analytics still work. AI stays off.</p>
            </>
          )}
          <p className="sidebar__note">
            {providers.length} provider{providers.length === 1 ? "" : "s"} configured · data stays in{" "}
            {desktop ? "local SQLite" : "IndexedDB"}
          </p>
        </div>
      </aside>

      <main className="content">
        <div className="content__topline">
          <span>{PAGE_TITLES[page]}</span>
          <span className="muted">Consent policy {consentState.policyVersion}</span>
        </div>

        {page === "setup" && <DesktopSetup onNavigate={navigate} />}
        {page === "dashboard" && <Dashboard onNavigate={navigate} />}
        {page === "assistant" && <Assistant onNavigate={navigate} />}
        {page === "sensors" && <Sensors onNavigate={navigate} />}
        {page === "privacy" && <PrivacyAiSettings onNavigate={navigate} />}
        {page === "audit" && <AuditLog />}

        <footer className="footer">
          HabitPilot does not upload personal health records automatically. AI requests only leave
          this device after an explicit, current permission for each category.
        </footer>
      </main>
    </div>
  );
}
