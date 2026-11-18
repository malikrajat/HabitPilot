import type { ReactNode } from "react";
import { getCategoryDefinition, getProviderDefinition } from "@habitpilot/consent-core";
import { useApp } from "../state/AppProvider.js";
import { Badge, Card, EmptyState } from "../components/ui.js";

const ACTION_TONE: Record<string, "good" | "warn" | "bad" | "info" | "neutral"> = {
  granted: "good",
  revoked: "bad",
  "external-access-enabled": "warn",
  "external-access-disabled": "neutral",
  "policy-version-changed": "info",
  "ai-request-allowed": "good",
  "ai-request-blocked": "warn",
  "sensor-access-enabled": "info",
  "sensor-access-disabled": "neutral",
};

export function AuditLog(): ReactNode {
  const { consentState, hosted, localAuditLog, consentMirror } = useApp();
  const localSensorEvents = localAuditLog.filter(
    (entry) =>
      entry.action === "sensor-access-enabled" || entry.action === "sensor-access-disabled",
  );
  const merged = new Map<string, (typeof consentState.auditLog)[number]>();
  for (const entry of [...consentState.auditLog, ...localSensorEvents]) {
    merged.set(entry.id, entry);
  }
  const entries = [...merged.values()].sort((a, b) => b.at.localeCompare(a.at));
  const mirror = consentMirror?.state ?? null;
  const mirrorGrantCount =
    mirror?.grants.filter(
      (grant) => grant.revokedAt === null && grant.policyVersion === mirror.policyVersion,
    ).length ?? 0;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Consent audit log</h1>
          <p className="muted">
            Timestamped consent changes and metadata-only AI attempts. No health data, message
            content or credentials are recorded here.
          </p>
        </div>
        <Badge tone={hosted ? "warn" : "good"}>
          {hosted ? "Server + local events" : "Stored on this device"}
        </Badge>
      </header>

      {hosted && consentMirror && mirror && (
        <Card
          title="Local gateway consent mirror"
          subtitle="Read-only copy of the last gateway consent state, stored on this device."
          tone="default"
        >
          <div className="row">
            <span>
              {mirrorGrantCount} active grant{mirrorGrantCount === 1 ? "" : "s"} � policy{" "}
              <code>{mirror.policyVersion}</code>
            </span>
            <span className="muted">
              synced {new Date(consentMirror.syncedAt).toLocaleString()}
            </span>
          </div>
          <p className="hint">
            The gateway remains authoritative for enforcement. This local copy exists for
            transparency and on-device records when the gateway is unavailable.
          </p>
        </Card>
      )}

      <Card
        title="Recent events"
        subtitle={`Policy version ${consentState.policyVersion}${hosted ? " � server events plus local sensor events" : ""}`}
      >
        {entries.length === 0 ? (
          <EmptyState title="No consent events yet">
            Grants, revocations and blocked AI attempts will appear here.
          </EmptyState>
        ) : (
          <ul className="audit-list">
            {entries.map((entry) => {
              const parts = [
                entry.category ? getCategoryDefinition(entry.category).label : null,
                entry.providerId ? getProviderDefinition(entry.providerId).label : null,
                entry.purpose ?? null,
              ].filter(Boolean);
              return (
                <li key={entry.id}>
                  <div className="audit-row">
                    <Badge tone={ACTION_TONE[entry.action] ?? "neutral"}>{entry.action}</Badge>
                    <span className="muted">
                      {new Date(entry.at).toLocaleString()} · policy {entry.policyVersion}
                    </span>
                  </div>
                  {parts.length > 0 && <p>{parts.join(" · ")}</p>}
                  {entry.metadata && (
                    <p className="hint">
                      {Object.entries(entry.metadata)
                        .filter(([key]) => key !== "at")
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" · ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="What is deliberately absent" tone="default">
        <ul className="plain-list">
          <li>No message bodies, prompts or AI responses.</li>
          <li>No weight values, meals, observations or other health records.</li>
          <li>No provider API keys or gateway session tokens.</li>
          <li>No camera frames, audio recordings or biometric samples.</li>
        </ul>
      </Card>
    </div>
  );
}
