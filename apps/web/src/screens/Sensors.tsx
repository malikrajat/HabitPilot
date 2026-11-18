import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getCategoryDefinition,
  getConsentStatus,
  type DataCategory,
  type PurposeId,
} from "@habitpilot/consent-core";
import { useApp } from "../state/AppProvider.js";
import { Badge, Card, EmptyState } from "../components/ui.js";
import {
  EMPTY_SENSOR_SNAPSHOT,
  SensorController,
  describeSensorError,
  type SensorSnapshot,
} from "../lib/sensors.js";
import { toIsoDay } from "../lib/sampleData.js";
import type { Page } from "../navigation.js";

const OBSERVATION_CATEGORIES: readonly {
  category: DataCategory;
  source: string;
}[] = [
  {
    category: "observations.posture_eye_screen",
    source: "Camera movement breaks and session duration (derived on device).",
  },
  {
    category: "observations.eating",
    source: "Reserved for on-device eating summaries. No chewing detector is implemented.",
  },
  {
    category: "observations.breathing",
    source: "Reserved for on-device breathing summaries. No audio analysis for breathing is implemented.",
  },
];

const STATUS_TONE = {
  granted: "good",
  "not-granted": "neutral",
  "policy-outdated": "warn",
  "provider-changed": "warn",
  revoked: "bad",
} as const;

const STATUS_LABEL = {
  granted: "AI access granted",
  "not-granted": "AI access not granted",
  "policy-outdated": "Needs renewal",
  "provider-changed": "Provider changed",
  revoked: "Revoked",
} as const;

export function Sensors({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const {
    health,
    activeProvider,
    activeProviderFingerprint,
    consentState,
    sensorPreferences,
    setSensorPreference,
    recordSensorAudit,
    addObservation,
    desktop,
  } = useApp();

  const [snapshot, setSnapshot] = useState<SensorSnapshot>(EMPTY_SENSOR_SNAPSHOT);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"camera" | "microphone" | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controllerRef = useRef<SensorController | null>(null);
  const setSensorPreferenceRef = useRef(setSensorPreference);
  setSensorPreferenceRef.current = setSensorPreference;
  const recordSensorAuditRef = useRef(recordSensorAudit);
  recordSensorAuditRef.current = recordSensorAudit;

  useEffect(() => {
    const controller = new SensorController(setSnapshot);
    controllerRef.current = controller;
    return () => {
      const before = controller.snapshot();
      controller.stopAll();
      controllerRef.current = null;
      if (before.camera.active) {
        void setSensorPreferenceRef.current("cameraOptIn", false);
        void recordSensorAuditRef.current("camera", false);
      }
      if (before.microphone.active) {
        void setSensorPreferenceRef.current("microphoneOptIn", false);
        void recordSensorAuditRef.current("microphone", false);
      }
    };
  }, []);

  const purpose: PurposeId = "observation-review";
  const activeFingerprint = activeProviderFingerprint ?? undefined;

  const startCamera = async () => {
    setBusy("camera");
    setCameraError(null);
    setMessage(null);
    try {
      if (!videoRef.current) throw new Error("The preview element is not ready.");
      await controllerRef.current?.startCamera(videoRef.current);
      await setSensorPreference("cameraOptIn", true);
      await recordSensorAudit("camera", true);
    } catch (error) {
      setCameraError(describeSensorError("camera", error));
      await setSensorPreference("cameraOptIn", false);
    } finally {
      setBusy(null);
    }
  };

  const stopCamera = async () => {
    controllerRef.current?.stopCamera();
    await setSensorPreference("cameraOptIn", false);
    await recordSensorAudit("camera", false);
    setMessage("Camera stopped. The video track was released immediately.");
  };

  const startMicrophone = async () => {
    setBusy("microphone");
    setMicrophoneError(null);
    setMessage(null);
    try {
      await controllerRef.current?.startMicrophone();
      await setSensorPreference("microphoneOptIn", true);
      await recordSensorAudit("microphone", true);
    } catch (error) {
      setMicrophoneError(describeSensorError("microphone", error));
      await setSensorPreference("microphoneOptIn", false);
    } finally {
      setBusy(null);
    }
  };

  const stopMicrophone = async () => {
    controllerRef.current?.stopMicrophone();
    await setSensorPreference("microphoneOptIn", false);
    await recordSensorAudit("microphone", false);
    setMessage("Microphone stopped. The audio track and analyser were released immediately.");
  };

  const saveCameraObservation = async () => {
    const record = controllerRef.current?.cameraObservation(toIsoDay(0));
    if (!record) {
      setMessage("Run the camera for at least a minute before saving an observation.");
      return;
    }
    await addObservation("observations.posture_eye_screen", record);
    setMessage(
      "Observation saved locally as text. It is not shared with any provider until you grant the category and approve a specific request.",
    );
  };

  const playTestTone = async () => {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setMessage("Web Audio is unavailable, so the speaker test could not run.");
      return;
    }
    const context = new AudioContextCtor();
    await context.resume();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 523.25;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.onended = () => void context.close().catch(() => undefined);
  };

  const savedObservations = health?.snapshot.observations?.postureEyeScreen ?? [];

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Sensors &amp; observations</h1>
          <p className="muted">
            Camera and microphone access is requested here, explicitly, and can be revoked at any
            time. Raw video and audio never go to an AI provider.
          </p>
        </div>
        <Badge tone="good">local capture only</Badge>
      </header>

      <div className="callout">
        <strong>Video frames and audio recordings are never transmitted.</strong>
        <p className="muted">
          Frames are downscaled in memory to count movement events, then discarded. Audio is
          analysed for level only and never recorded. Only a text summary can be saved locally, and
          it can reach AI only after you grant{" "}
          <code>observations.posture_eye_screen</code> for a provider and purpose, then approve the
          specific send.
        </p>
      </div>

      {message && <p className="callout callout--success">{message}</p>}

      <div className="sensor-grid">
        <Card
          title="Camera"
          subtitle="Permission is requested by the operating system/browser when you press Enable."
          actions={
            <Badge tone={snapshot.camera.active ? "good" : "neutral"}>
              {snapshot.camera.active ? "capturing locally" : "off"}
            </Badge>
          }
        >
          <div className={`camera-frame ${snapshot.camera.active ? "camera-frame--live" : ""}`}>
            <video
              ref={videoRef}
              className="camera-video"
              playsInline
              muted
              autoPlay
              aria-label="Local camera preview; never transmitted"
            />
            {!snapshot.camera.active && (
              <div className="camera-frame__placeholder">
                <strong>Camera is off</strong>
                <span>No video track exists until you press Enable.</span>
              </div>
            )}
            <span className="camera-frame__tag">LOCAL ONLY</span>
          </div>

          <div className="row row--tight" style={{ marginTop: "0.7rem" }}>
            <button
              type="button"
              className="button"
              onClick={() => void startCamera()}
              disabled={busy !== null || snapshot.camera.active}
            >
              {busy === "camera" ? "Requesting…" : "Enable camera"}
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void stopCamera()}
              disabled={!snapshot.camera.active}
            >
              Stop &amp; revoke
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void saveCameraObservation()}
              disabled={snapshot.camera.framesAnalyzed < 2 || snapshot.camera.minutes < 1}
            >
              Save text observation
            </button>
          </div>

          {cameraError && <p className="callout callout--danger">{cameraError}</p>}

          <dl className="sensor-stats">
            <div>
              <dt>Session</dt>
              <dd>{snapshot.camera.minutes.toFixed(1)} min</dd>
            </div>
            <div>
              <dt>Movement breaks</dt>
              <dd>{snapshot.camera.movementBreaks}</dd>
            </div>
            <div>
              <dt>Frames analysed</dt>
              <dd>{snapshot.camera.framesAnalyzed}</dd>
            </div>
            <div>
              <dt>Frames stored</dt>
              <dd>0</dd>
            </div>
          </dl>
          <p className="hint">
            Camera sessions automatically stop after 30 minutes. Closing this screen also stops
            capture.
          </p>
        </Card>

        <Card
          title="Microphone"
          subtitle="Level analysis only. Nothing is recorded and no audio buffer leaves memory."
          actions={
            <Badge tone={snapshot.microphone.active ? "good" : "neutral"}>
              {snapshot.microphone.active ? "analysing locally" : "off"}
            </Badge>
          }
        >
          <div className="level-meter" aria-label="Microphone level">
            <div
              className="level-meter__fill"
              style={{ width: `${snapshot.microphone.levelPercent}%` }}
            />
          </div>
          <p className="hint">
            Input level {snapshot.microphone.levelPercent}% · average{" "}
            {Math.round(snapshot.microphone.averageLevelPercent)}%
          </p>

          <div className="row row--tight" style={{ marginTop: "0.7rem" }}>
            <button
              type="button"
              className="button"
              onClick={() => void startMicrophone()}
              disabled={busy !== null || snapshot.microphone.active}
            >
              {busy === "microphone" ? "Requesting…" : "Enable microphone"}
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void stopMicrophone()}
              disabled={!snapshot.microphone.active}
            >
              Stop &amp; revoke
            </button>
          </div>

          {microphoneError && <p className="callout callout--danger">{microphoneError}</p>}

          <dl className="sensor-stats">
            <div>
              <dt>Session</dt>
              <dd>{snapshot.microphone.minutes.toFixed(1)} min</dd>
            </div>
            <div>
              <dt>Audio stored</dt>
              <dd>0 bytes</dd>
            </div>
          </dl>
          <p className="hint">
            Eating and breathing observations are not derived from audio yet. HabitPilot does not
            guess medical or behavioural facts from sound.
          </p>
        </Card>

        <Card
          title="Audio output (speaker)"
          subtitle="There is no speaker permission prompt in browsers or Windows."
          actions={<Badge tone="neutral">system-controlled</Badge>}
        >
          <p className="muted">
            Playback uses your Windows volume and output device, so there is nothing for HabitPilot
            to grant or revoke here. Headphones and output routing are controlled by the OS.
          </p>
          <div className="row row--tight" style={{ marginTop: "0.7rem" }}>
            <button type="button" className="button button--ghost" onClick={() => void playTestTone()}>
              Play test tone
            </button>
          </div>

          <label className="checkbox-row" style={{ marginTop: "0.8rem" }}>
            <input
              type="checkbox"
              checked={sensorPreferences.speakReplies}
              onChange={(event) =>
                void setSensorPreference("speakReplies", event.target.checked)
              }
            />
            <span>
              Read AI replies aloud using a local operating-system voice. If no local voice is
              installed, read-aloud stays off rather than using a cloud voice.
            </span>
          </label>
        </Card>
      </div>

      <Card
        title="Where to revoke device access fully"
        subtitle="HabitPilot stops capture immediately; OS and browser grants are managed by the platform."
      >
        <ul className="plain-list">
          <li>
            <strong>In HabitPilot:</strong> press <em>Stop &amp; revoke</em>; tracks and the audio
            analyser are released at once, and leaving this screen stops capture.
          </li>
          <li>
            <strong>Windows:</strong> Settings → Privacy &amp; security → Camera / Microphone. Turn
            off app access or desktop-app access.
          </li>
          <li>
            <strong>Browser:</strong> site settings → Camera / Microphone → reset or block for this
            origin.
          </li>
          {desktop && (
            <li>
              <strong>Desktop app:</strong> the same Windows privacy switches apply to the WebView2
              window.
            </li>
          )}
        </ul>
      </Card>

      <Card
        title="AI access to these observations"
        subtitle="Sensor access and AI data-sharing consent are separate. Granting a camera does not grant AI access."
        actions={
          <button type="button" className="button" onClick={() => onNavigate("privacy")}>
            Open Privacy &amp; AI Settings
          </button>
        }
      >
        {!activeProvider ? (
          <p className="callout callout--warning">
            No provider is configured, so no observation category can be granted for AI. Local
            capture and local summaries still work.
          </p>
        ) : (
          <ul className="consent-list">
            {OBSERVATION_CATEGORIES.map((entry) => {
              const status = getConsentStatus(
                consentState,
                entry.category,
                activeProvider.providerId,
                purpose,
                activeFingerprint,
              );
              return (
                <li key={entry.category} className="consent-item">
                  <div className="consent-item__main">
                    <div className="row row--tight">
                      <strong>{getCategoryDefinition(entry.category).label}</strong>
                      <Badge tone={STATUS_TONE[status.status]}>{STATUS_LABEL[status.status]}</Badge>
                      <Badge tone="warn">per-request approval</Badge>
                    </div>
                    <p className="hint">{entry.source}</p>
                    <p className="hint">
                      Purpose required: <code>observation-review</code>. Each send still needs an
                      explicit confirmation.
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card
        title="Saved on-device observations"
        subtitle="Derived text only. Stored in local SQLite/IndexedDB, never uploaded automatically."
      >
        {savedObservations.length === 0 ? (
          <EmptyState title="No camera observations saved yet">
            Enable the camera for at least a minute, then press Save text observation.
          </EmptyState>
        ) : (
          <ul className="observation-list">
            {savedObservations.slice(0, 5).map((observation) => (
              <li key={`${observation.date}-${observation.summary}`}>
                <div className="row">
                  <strong>{observation.date}</strong>
                  <Badge tone="neutral">local</Badge>
                </div>
                <p className="muted">{observation.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
