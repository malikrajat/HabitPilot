/** Pure helpers for on-device sensor analysis. No media is stored or transmitted. */

export function rmsFromTimeDomain(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Mean absolute difference between two RGBA frames (0-255).
 * Used only to count movement events; frames are discarded after each sample.
 */
export function frameDifference(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
): number {
  const length = Math.min(previous.length, current.length);
  if (length === 0) return 0;
  let sum = 0;
  let samples = 0;
  for (let index = 0; index < length; index += 4) {
    sum += Math.abs((previous[index] ?? 0) - (current[index] ?? 0));
    sum += Math.abs((previous[index + 1] ?? 0) - (current[index + 1] ?? 0));
    sum += Math.abs((previous[index + 2] ?? 0) - (current[index + 2] ?? 0));
    samples += 3;
  }
  return samples === 0 ? 0 : sum / samples;
}

export function movementSummary(minutes: number, breaks: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  return `${rounded} minute on-device camera session with ${breaks} movement break${
    breaks === 1 ? "" : "s"
  } (derived locally; no frames stored or sent)`;
}

export function microphoneSummary(minutes: number, averageLevelPercent: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  return `${rounded} minute microphone session, average input level ${Math.round(
    averageLevelPercent,
  )}% (derived locally; no audio stored or sent)`;
}
