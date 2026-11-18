import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AI_TASKS,
  MESSAGES,
  getAiTask,
  getCategoryDefinition,
  type AiRequestInput,
  type DataCategory,
} from "@habitpilot/consent-core";
import { useApp, type AiOutcome, type AiPreviewOutcome } from "../state/AppProvider.js";
import { Badge, Card, CategoryBadge, DisclosureList, EmptyState } from "../components/ui.js";
import type { Page } from "../navigation.js";

function defaultCategories(taskId: string): DataCategory[] {
  const task = getAiTask(taskId);
  if (!task) return [];
  if (task.requiredCategories.length > 0) return [...task.requiredCategories];
  const preferred = task.allowedCategories.find(
    (category) => category === "body.weight_goals" || category === "lifestyle.sleep_hydration_activity",
  );
  return [preferred ?? task.allowedCategories[0]].filter(
    (category): category is DataCategory => Boolean(category),
  );
}

export function Assistant({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const {
    health,
    activeProvider,
    hosted,
    gatewayConnected,
    gatewayError,
    previewAi,
    sendAi,
    working,
    speakReplies,
  } = useApp();

  const speak = (text: string) => {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return;
    // Only local voices are used. A cloud-backed voice could transmit response
    // text, which would contradict the local-only claim.
    const localVoice = window.speechSynthesis
      .getVoices()
      .find((voice) => voice.localService === true);
    if (!localVoice) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = localVoice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const [taskId, setTaskId] = useState("daily-summary");
  const [selected, setSelected] = useState<DataCategory[]>(defaultCategories("daily-summary"));
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<AiPreviewOutcome | null>(null);
  const [result, setResult] = useState<AiOutcome | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!speakReplies || !result?.ok || !result.text) return;
    speak(result.text);
    return () => {
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, [speakReplies, result]);

  const task = useMemo(() => getAiTask(taskId), [taskId]);

  const reset = () => {
    setPreview(null);
    setResult(null);
    setLocalError(null);
    setConfirmed(false);
  };

  const changeTask = (nextId: string) => {
    setTaskId(nextId);
    setSelected(defaultCategories(nextId));
    reset();
  };

  const toggleCategory = (category: DataCategory) => {
    if (task?.requiredCategories.includes(category)) return;
    setSelected((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
    reset();
  };

  const buildInput = (isConfirmed: boolean, approvalToken?: string): AiRequestInput | null => {
    if (!task || !activeProvider || !health) return null;
    return {
      taskId: task.id,
      purpose: task.purpose,
      providerId: activeProvider.providerId,
      requestedCategories: selected,
      data: health.snapshot,
      confirmed: isConfirmed,
      ...(approvalToken ? { approvalToken } : {}),
    };
  };

  const review = async (isConfirmed = confirmed) => {
    const input = buildInput(isConfirmed);
    if (!input) return;
    setLocalError(null);
    setResult(null);
    try {
      const next = await previewAi(input);
      setPreview(next);
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "The disclosure could not be prepared. Nothing was sent.",
      );
    }
  };

  const changeConfirmation = async (next: boolean) => {
    setConfirmed(next);
    await review(next);
  };

  const send = async () => {
    const input = buildInput(confirmed, preview?.approvalToken);
    if (!input) return;
    setLocalError(null);
    const outcome = await sendAi(input);
    setResult(outcome);
    // Hosted approvals are single-use. Require a fresh review for another send.
    setPreview(null);
  };

  if (!activeProvider) {
    return (
      <div className="stack">
        <header className="page-head">
          <h1>AI Assistant</h1>
        </header>
        <Card title="No AI provider is configured" tone="warning">
          <p>{MESSAGES.noProvider}</p>
          <p className="muted">
            HabitPilot will not pick a provider for you, and it will not fall back to one. Configure a
            local model or connect the hosted gateway first.
          </p>
          <button type="button" className="button" onClick={() => onNavigate("privacy")}>
            Open Privacy &amp; AI Settings
          </button>
        </Card>
      </div>
    );
  }

  const blocked = preview && !preview.decision.allowed ? preview.decision : null;
  const requiresConfirmation = preview?.decision.requiresConfirmation ?? false;
  const canSend =
    Boolean(preview?.decision.allowed) &&
    (!requiresConfirmation || confirmed) &&
    !working &&
    (!hosted || gatewayConnected);

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>AI Assistant</h1>
          <p className="muted">
            Every request passes through the consent layer. Nothing is sent until you review the
            disclosure.
          </p>
        </div>
        <Badge tone={hosted ? "warn" : "good"}>
          {hosted ? "Remote provider via gateway" : "On-device model"}
        </Badge>
      </header>

      {hosted && !gatewayConnected && (
        <Card title="Secure gateway is not connected" tone="danger">
          <p>
            This provider is remote. HabitPilot will not send a remote request without the gateway,
            because the gateway enforces your consent independently.
          </p>
          {gatewayError && <p className="muted">{gatewayError}</p>}
          <button type="button" className="button" onClick={() => onNavigate("privacy")}>
            Reconnect in Privacy &amp; AI Settings
          </button>
        </Card>
      )}

      <Card
        title="1. Choose the task"
        subtitle="The task fixes the purpose. Categories outside its ceiling cannot be selected."
      >
        <label className="field">
          <span>Task</span>
          <select value={taskId} onChange={(event) => changeTask(event.target.value)}>
            {AI_TASKS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {task && (
          <div className="task-meta">
            <p className="muted">{task.description}</p>
            <p className="hint">
              Purpose: <code>{task.purpose}</code> · Provider: <code>{activeProvider.providerId}</code>{" "}
              ({activeProvider.locality})
            </p>
          </div>
        )}
      </Card>

      <Card
        title="2. Select the minimum data"
        subtitle="Only checked categories can enter the payload. Each one needs its own grant."
      >
        {task && (
          <>
            <div className="category-select">
              {task.allowedCategories.map((category) => {
                const definition = getCategoryDefinition(category);
                const isSelected = selected.includes(category);
                const isRequired = task.requiredCategories.includes(category);
                return (
                  <label
                    key={category}
                    className={`category-option ${isSelected ? "category-option--on" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isRequired}
                      onChange={() => toggleCategory(category)}
                    />
                    <span className="category-option__body">
                      <span className="row row--tight">
                        <strong>{definition.label}</strong>
                        <CategoryBadge category={category} />
                        {isRequired && <Badge tone="info">required</Badge>}
                      </span>
                      <span className="muted">{definition.summary}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="hint">
              {task.requiredCategories.length > 0
                ? `This task requires: ${task.requiredCategories
                    .map((category) => getCategoryDefinition(category).label)
                    .join(", ")}.`
                : task.minimumCategories > 0
                  ? "This task requires at least one of the categories above."
                  : "This task can run without personal context."}
            </p>
          </>
        )}
        <p className="hint">
          Raw camera frames, microphone recordings, video and biometric captures are never included.
        </p>
      </Card>

      <Card
        title="3. Review the disclosure"
        subtitle="Nothing is transmitted during this step."
        actions={
          <button
            type="button"
            className="button"
            onClick={() => void review()}
            disabled={working || selected.length === 0}
          >
            Review what will be sent
          </button>
        }
      >
        {localError && <p className="callout callout--danger">{localError}</p>}

        {!preview && (
          <EmptyState title="No disclosure prepared yet">
            Choose categories, then review. The send button stays disabled until you do.
          </EmptyState>
        )}

        {preview && (
          <div className="stack stack--tight">
            <div className="row">
              <Badge tone={preview.decision.allowed ? "good" : "bad"}>
                {preview.decision.allowed ? "Consent verified" : preview.decision.code}
              </Badge>
              <span className="muted">
                {preview.categories.length} categories · {preview.recordCount} records ·{" "}
                {preview.estimatedBytes} bytes
              </span>
            </div>

            <DisclosureList items={preview.decision.disclosures} />

            {blocked && (
              <div className="callout callout--danger">
                <strong>{blocked.message}</strong>
                {blocked.missingCategories.length > 0 && (
                  <p className="muted">
                    Missing:{" "}
                    {blocked.missingCategories
                      .map((category) => getCategoryDefinition(category).label)
                      .join(", ")}
                  </p>
                )}
                {blocked.outdatedCategories.length > 0 && (
                  <p className="muted">
                    These grants were made under an older policy version and must be renewed.
                  </p>
                )}
                <button type="button" className="button" onClick={() => onNavigate("privacy")}>
                  Open Privacy &amp; AI Settings
                </button>
              </div>
            )}

            {requiresConfirmation && preview.decision.allowed === false && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => void changeConfirmation(event.target.checked)}
                />
                <span>
                  I approve sharing these sensitive categories for this specific request.
                </span>
              </label>
            )}

            {requiresConfirmation && preview.decision.allowed && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => void changeConfirmation(event.target.checked)}
                />
                <span>Approval covers this request only. It is not remembered.</span>
              </label>
            )}
          </div>
        )}
      </Card>

      <Card
        title="4. Send"
        subtitle="A blocked preview cannot be sent."
        actions={
          <button type="button" className="button button--primary" onClick={() => void send()} disabled={!canSend}>
            {working ? "Sending…" : "Send approved request"}
          </button>
        }
      >
        {!canSend && (
          <p className="hint">
            Send stays disabled until a reviewed, allowed payload exists and any required
            confirmation is checked.
          </p>
        )}

        {result?.ok && (
          <div className="stack stack--tight">
            <div className="row">
              <Badge tone="good">Response received</Badge>
              {result.model && <span className="muted">model: {result.model}</span>}
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => result.text && speak(result.text)}
                title="Uses a local OS voice only"
              >
                Read aloud
              </button>
            </div>
            <pre className="response">{result.text}</pre>
            {result.transmission && (
              <p className="hint">
                Sent to {result.transmission.providerId} ({result.transmission.providerLocality}) ·{" "}
                {result.transmission.categories.length} categories ·{" "}
                {result.transmission.estimatedBytes} bytes · policy{" "}
                {result.transmission.policyVersion} ·{" "}
                {result.transmission.historyMode === "complete" ? "complete history" : "recent window"}
              </p>
            )}
          </div>
        )}

        {result && !result.ok && result.error && (
          <div className="callout callout--danger">
            <strong>{result.error.message}</strong>
            {result.error.missingCategories.length > 0 && (
              <p className="muted">
                Missing:{" "}
                {result.error.missingCategories
                  .map((category) => getCategoryDefinition(category).label)
                  .join(", ")}
              </p>
            )}
            <button type="button" className="button" onClick={() => onNavigate("privacy")}>
              Open Privacy &amp; AI Settings
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
