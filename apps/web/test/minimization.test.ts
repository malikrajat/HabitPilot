import { describe, expect, it } from "vitest";
import { createSampleHealthData } from "../src/lib/sampleData.js";
import { selectSnapshotForCategories } from "../src/lib/dataSelection.js";

const data = createSampleHealthData();

describe("client-side payload minimization", () => {
  it("includes only the selected categories", () => {
    const subset = selectSnapshotForCategories(data.snapshot, ["body.weight_goals"]);
    expect(Object.keys(subset)).toEqual(["weight"]);
    expect(JSON.stringify(subset)).not.toContain("breakfast");
    expect(JSON.stringify(subset)).not.toContain("posture breaks");
  });

  it("keeps observations separate by category", () => {
    const subset = selectSnapshotForCategories(data.snapshot, ["observations.breathing"]);
    expect(subset.observations?.breathing?.length).toBeGreaterThan(0);
    expect(subset.observations?.eating).toBeUndefined();
    expect(subset.observations?.postureEyeScreen).toBeUndefined();
  });

  it("treats complete history as a scope widening, not a category", () => {
    const alone = selectSnapshotForCategories(data.snapshot, ["history.complete"]);
    expect(Object.keys(alone)).toEqual([]);

    const widened = selectSnapshotForCategories(data.snapshot, [
      "history.complete",
      "body.weight_goals",
    ]);
    expect(Object.keys(widened)).toEqual(["weight"]);
    expect(widened.weight?.entries.length).toBe(data.snapshot.weight?.entries.length);
  });

  it("bounds recent windows unless complete history is approved", () => {
    const recent = selectSnapshotForCategories(data.snapshot, ["body.weight_goals"]);
    expect(recent.weight?.entries.length).toBeLessThanOrEqual(14);
    expect(recent.weight?.entries.length).toBeLessThan(
      data.snapshot.weight?.entries.length ?? 0,
    );
  });

  it("drops categories that were not requested", () => {
    const subset = selectSnapshotForCategories(data.snapshot, [
      "personal.profile",
      "lifestyle.sleep_hydration_activity",
    ]);
    expect(subset.profile).toBeDefined();
    expect(subset.lifestyle).toBeDefined();
    expect(subset.weight).toBeUndefined();
    expect(subset.nutrition).toBeUndefined();
  });
});

describe("local demo data", () => {
  it("is deterministic in shape and contains derived observations only", () => {
    const again = createSampleHealthData();
    expect(again.snapshot.weight?.entries).toHaveLength(data.snapshot.weight?.entries.length);
    expect(again.meals).toHaveLength(data.meals.length);
    expect(again.habits).toHaveLength(3);

    const serialized = JSON.stringify(data.snapshot);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("cameraFrame");
  });

  it("provides enough history for deterministic analytics", () => {
    expect(data.snapshot.weight?.entries.length).toBeGreaterThanOrEqual(28);
    expect(data.lifestyleDays.length).toBeGreaterThanOrEqual(7);
    expect(data.eatingSessions.length).toBeGreaterThan(0);
  });
});
