import { describe, expect, it } from "vitest";
import {
  frameDifference,
  microphoneSummary,
  movementSummary,
  rmsFromTimeDomain,
} from "../src/lib/sensorMath.js";

describe("on-device sensor math", () => {
  it("computes RMS level from time-domain samples", () => {
    expect(rmsFromTimeDomain(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 5);
    expect(rmsFromTimeDomain(new Float32Array([]))).toBe(0);
  });

  it("returns zero difference for identical frames", () => {
    const frame = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(frameDifference(frame, frame)).toBe(0);
  });

  it("detects large frame changes", () => {
    const before = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const after = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect(frameDifference(before, after)).toBe(255);
  });

  it("describes camera summaries as local, non-medical derivations", () => {
    const summary = movementSummary(42.4, 3);
    expect(summary).toContain("42 minute");
    expect(summary).toContain("3 movement breaks");
    expect(summary).toContain("no frames stored or sent");
    expect(summary.toLowerCase()).not.toContain("posture quality");
  });

  it("describes microphone summaries without recording", () => {
    const summary = microphoneSummary(5.2, 31.6);
    expect(summary).toContain("5 minute");
    expect(summary).toContain("32%");
    expect(summary).toContain("no audio stored or sent");
  });
});
