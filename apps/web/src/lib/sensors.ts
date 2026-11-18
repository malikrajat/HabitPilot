import type { ObservationRecord } from "@habitpilot/consent-core";
import { frameDifference, microphoneSummary, movementSummary, rmsFromTimeDomain } from "./sensorMath.js";

export type SensorKind = "camera" | "microphone";

export interface SensorSnapshot {
  readonly camera: {
    readonly active: boolean;
    readonly startedAt: number | null;
    readonly minutes: number;
    readonly movementBreaks: number;
    readonly framesAnalyzed: number;
  };
  readonly microphone: {
    readonly active: boolean;
    readonly startedAt: number | null;
    readonly minutes: number;
    readonly levelPercent: number;
    readonly averageLevelPercent: number;
  };
}

export const EMPTY_SENSOR_SNAPSHOT: SensorSnapshot = {
  camera: {
    active: false,
    startedAt: null,
    minutes: 0,
    movementBreaks: 0,
    framesAnalyzed: 0,
  },
  microphone: {
    active: false,
    startedAt: null,
    minutes: 0,
    levelPercent: 0,
    averageLevelPercent: 0,
  },
};

const CAMERA_SAMPLE_MS = 500;
const MIC_SAMPLE_MS = 100;
const MOVEMENT_THRESHOLD = 14;
const BREAK_STILL_MS = 20_000;

export interface CameraLimits {
  readonly maxMinutes: number;
}

export const DEFAULT_CAMERA_LIMITS: CameraLimits = { maxMinutes: 30 };

function minutesSince(startedAt: number | null): number {
  if (!startedAt) return 0;
  return (Date.now() - startedAt) / 60_000;
}

export function describeSensorError(kind: SensorKind, error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const label = kind === "camera" ? "Camera" : "Microphone";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return `${label} permission was denied. Allow it in Windows Settings → Privacy & security → ${
        kind === "camera" ? "Camera" : "Microphone"
      } (and in your browser site settings), then try again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${kind} was found on this device.`;
    case "NotReadableError":
      return `The ${kind} is already in use by another application.`;
    default:
      return `${label} could not be started. No capture is active.`;
  }
}

/**
 * Local-only sensor capture.
 *
 * Camera frames are downscaled, compared in memory and immediately discarded.
 * Audio is analysed for level only and never recorded. No frames, audio buffers
 * or biometric templates are stored, persisted or exposed to AI transports.
 */
export class SensorController {
  readonly #onChange: (snapshot: SensorSnapshot) => void;
  readonly #cameraLimits: CameraLimits;

  #cameraStream: MediaStream | null = null;
  #video: HTMLVideoElement | null = null;
  #cameraTimer: number | null = null;
  #cameraStartedAt: number | null = null;
  #framesAnalyzed = 0;
  #movementBreaks = 0;
  #lastMotionAt = 0;
  #previousFrame: Uint8ClampedArray | null = null;
  #canvas: HTMLCanvasElement | null = null;

  #microphoneStream: MediaStream | null = null;
  #audioContext: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #microphoneTimer: number | null = null;
  #microphoneStartedAt: number | null = null;
  #levelPercent = 0;
  #levelSum = 0;
  #levelSamples = 0;

  constructor(onChange: (snapshot: SensorSnapshot) => void, limits: CameraLimits = DEFAULT_CAMERA_LIMITS) {
    this.#onChange = onChange;
    this.#cameraLimits = limits;
  }

  snapshot(): SensorSnapshot {
    return {
      camera: {
        active: this.#cameraStream !== null,
        startedAt: this.#cameraStartedAt,
        minutes: minutesSince(this.#cameraStartedAt),
        movementBreaks: this.#movementBreaks,
        framesAnalyzed: this.#framesAnalyzed,
      },
      microphone: {
        active: this.#microphoneStream !== null,
        startedAt: this.#microphoneStartedAt,
        minutes: minutesSince(this.#microphoneStartedAt),
        levelPercent: this.#levelPercent,
        averageLevelPercent:
          this.#levelSamples === 0 ? 0 : this.#levelSum / this.#levelSamples,
      },
    };
  }

  #emit(): void {
    this.#onChange(this.snapshot());
  }

  get cameraSupported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  get microphoneSupported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async startCamera(video: HTMLVideoElement): Promise<void> {
    this.stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user",
      },
      audio: false,
    });
    this.#cameraStream = stream;
    this.#video = video;
    video.srcObject = stream;
    video.muted = true;
    await video.play().catch(() => undefined);

    this.#cameraStartedAt = Date.now();
    this.#lastMotionAt = Date.now();
    this.#framesAnalyzed = 0;
    this.#movementBreaks = 0;
    this.#previousFrame = null;

    this.#cameraTimer = window.setInterval(() => this.#sampleCameraFrame(), CAMERA_SAMPLE_MS);
    this.#emit();
  }

  #sampleCameraFrame(): void {
    if (
      !this.#video ||
      !this.#cameraStartedAt ||
      minutesSince(this.#cameraStartedAt) >= this.#cameraLimits.maxMinutes
    ) {
      this.stopCamera();
      return;
    }
    if (this.#video.readyState < 2 || this.#video.videoWidth === 0) return;

    const canvas = (this.#canvas ??= document.createElement("canvas"));
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    context.drawImage(this.#video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height).data;

    if (this.#previousFrame) {
      const difference = frameDifference(this.#previousFrame, frame);
      const now = Date.now();
      if (difference > MOVEMENT_THRESHOLD) {
        if (now - this.#lastMotionAt >= BREAK_STILL_MS) this.#movementBreaks += 1;
        this.#lastMotionAt = now;
      }
    }

    this.#previousFrame = new Uint8ClampedArray(frame);
    this.#framesAnalyzed += 1;
    this.#emit();
  }

  stopCamera(): void {
    if (this.#cameraTimer !== null) {
      window.clearInterval(this.#cameraTimer);
      this.#cameraTimer = null;
    }
    if (this.#video) {
      this.#video.srcObject = null;
      this.#video = null;
    }
    if (this.#cameraStream) {
      for (const track of this.#cameraStream.getTracks()) track.stop();
      this.#cameraStream = null;
    }
    this.#previousFrame = null;
    this.#emit();
  }

  async startMicrophone(): Promise<void> {
    this.stopMicrophone();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
    this.#microphoneStream = stream;
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      this.stopMicrophone();
      throw new Error("Web Audio is not available, so microphone levels cannot be analysed.");
    }
    const context = new AudioContextCtor();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    this.#audioContext = context;
    this.#analyser = analyser;
    this.#microphoneStartedAt = Date.now();
    this.#levelSum = 0;
    this.#levelSamples = 0;

    this.#microphoneTimer = window.setInterval(() => {
      if (!this.#analyser) return;
      const samples = new Float32Array(this.#analyser.fftSize);
      this.#analyser.getFloatTimeDomainData(samples);
      const rms = rmsFromTimeDomain(samples);
      this.#levelPercent = Math.min(100, Math.round(rms * 400));
      this.#levelSum += this.#levelPercent;
      this.#levelSamples += 1;
      this.#emit();
    }, MIC_SAMPLE_MS);

    this.#emit();
  }

  stopMicrophone(): void {
    if (this.#microphoneTimer !== null) {
      window.clearInterval(this.#microphoneTimer);
      this.#microphoneTimer = null;
    }
    this.#analyser = null;
    if (this.#audioContext) {
      void this.#audioContext.close().catch(() => undefined);
      this.#audioContext = null;
    }
    if (this.#microphoneStream) {
      for (const track of this.#microphoneStream.getTracks()) track.stop();
      this.#microphoneStream = null;
    }
    this.#levelPercent = 0;
    this.#emit();
  }

  stopAll(): void {
    this.stopCamera();
    this.stopMicrophone();
  }

  /** Creates a local derived observation. Returns null when there is no session. */
  cameraObservation(date: string): ObservationRecord | null {
    if (!this.#cameraStartedAt) return null;
    const minutes = minutesSince(this.#cameraStartedAt);
    // Require a real one-minute session so the stored text is not misleading.
    if (minutes < 1) return null;
    return {
      date,
      summary: movementSummary(minutes, this.#movementBreaks),
      durationMinutes: Math.max(1, Math.round(minutes)),
      metrics: {
        sessionMinutes: Math.max(1, Math.round(minutes)),
        movementBreaks: this.#movementBreaks,
        framesAnalyzed: this.#framesAnalyzed,
      },
      confidence: 0.5,
    };
  }

  /** Microphone sessions are available as a local summary but are not sent anywhere. */
  microphoneObservation(date: string): ObservationRecord | null {
    if (!this.#microphoneStartedAt) return null;
    const minutes = minutesSince(this.#microphoneStartedAt);
    const average = this.#levelSamples === 0 ? 0 : this.#levelSum / this.#levelSamples;
    return {
      date,
      summary: microphoneSummary(minutes, average),
      durationMinutes: Math.max(1, Math.round(minutes)),
      metrics: { sessionMinutes: Math.max(1, Math.round(minutes)), averageLevelPercent: average },
      confidence: 0.4,
    };
  }
}
