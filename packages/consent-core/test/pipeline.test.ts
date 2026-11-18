import { describe, expect, it, vi } from "vitest";
import {
  AiRequestPipeline,
  ConsentService,
  InMemoryConsentStore,
  applyExternalAccess,
  applyGrant,
  buildMinimalPayload,
  createInitialConsentState,
  describePayload,
  evaluateConsent,
  findRawCapture,
  providerFingerprint,
  resolveActiveProvider,
  type AiTransport,
  type HealthDataSnapshot,
  type ProviderConfiguration,
  type TransmissionRecord,
} from "../src/index.js";

const T0 = "2026-11-17T09:00:00.000Z";

const snapshot: HealthDataSnapshot = {
  profile: {
    ageRange: "30-39",
    biologicalSex: "male",
    heightCm: 178,
    activityLevel: "moderate",
    // @ts-expect-error - unapproved field must never survive projection
    medicalConditions: ["hypertension"],
  },
  weight: {
    entries: Array.from({ length: 20 }, (_, index) => ({
      date: `2026-11-${String(index + 1).padStart(2, "0")}`,
      kg: 82 - index * 0.1,
    })),
    goal: { targetWeightKg: 75, targetDate: "2027-03-01" },
  },
  nutrition: {
    meals: [
      { date: "2026-11-16", label: "lunch", kcal: 620, proteinG: 35 },
      { date: "2026-11-17", label: "breakfast", kcal: 410, proteinG: 24 },
    ],
  },
  observations: {
    eating: [
      { date: "2026-11-17", summary: "18-minute meal, 1.1 bites/sec", durationMinutes: 18 },
    ],
    breathing: [{ date: "2026-11-17", summary: "resting rate 14/min", confidence: 0.8 }],
  },
  lifestyle: { sleepHours: 7.2, hydrationMl: 1800, steps: 8400 },
};

const provider: ProviderConfiguration = {
  providerId: "ollama",
  model: "llama3.2",
  locality: "device",
  configuredAt: T0,
  status: "active",
};

const providerFingerprintValue = providerFingerprint(provider);

function allowedDecisionFor(
  categories: Parameters<typeof applyGrant>[1]["category"][],
  options: { historyMode?: "recent" | "complete"; confirmed?: boolean } = {},
) {
  const request = {
    taskId: "general-assistant",
    purpose: "general-assistant" as const,
    providerId: "ollama" as const,
    requestedCategories: categories,
    confirmed: options.confirmed ?? true,
  };
  let state = createInitialConsentState();
  for (const category of categories) {
    state = applyGrant(state, {
      category,
      providerId: "ollama",
      purpose: "general-assistant",
      providerFingerprint: providerFingerprintValue,
      at: T0,
    });
  }
  const decision = evaluateConsent({ state, provider, request, now: T0 });
  expect(decision.allowed).toBe(true);
  return { state, decision, request };
}

describe("minimal payload construction", () => {
  it("refuses to build a payload for a blocked decision", () => {
    const state = createInitialConsentState();
    const decision = evaluateConsent({
      state,
      provider,
      request: {
        taskId: "general-assistant",
        purpose: "general-assistant",
        providerId: "ollama",
        requestedCategories: ["personal.profile"],
      },
      now: T0,
    });
    expect(() => buildMinimalPayload(decision, snapshot)).toThrow(/blocked request/);
  });

  it("includes only the approved categories", () => {
    const { decision } = allowedDecisionFor(["body.weight_goals"]);
    const payload = buildMinimalPayload(decision, snapshot, { now: T0 });
    expect(payload.sections.map((section) => section.category)).toEqual(["body.weight_goals"]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("hypertension");
    expect(serialized).not.toContain("breakfast");
    expect(serialized).not.toContain("resting rate");
  });

  it("drops unapproved profile fields even when the category is approved", () => {
    const { decision } = allowedDecisionFor(["personal.profile"]);
    const payload = buildMinimalPayload(decision, snapshot, { now: T0 });
    expect(payload.sections[0]?.fields).toEqual({
      ageRange: "30-39",
      biologicalSex: "male",
      heightCm: 178,
      activityLevel: "moderate",
    });
    expect(JSON.stringify(payload)).not.toContain("medicalConditions");
  });

  it("bounds recent windows and unlocks complete history only with that category", () => {
    const { decision } = allowedDecisionFor(["body.weight_goals"]);
    const recentPayload = buildMinimalPayload(decision, snapshot, { now: T0 });
    expect(recentPayload.historyMode).toBe("recent");
    expect(recentPayload.sections[0]?.recordCount).toBe(14);

    const complete = allowedDecisionFor(["body.weight_goals", "history.complete"]);
    const completePayload = buildMinimalPayload(complete.decision, snapshot, { now: T0 });
    expect(completePayload.historyMode).toBe("complete");
    expect(completePayload.sections[0]?.recordCount).toBe(20);
  });

  it("does not let complete-history consent authorize other categories", () => {
    const { decision } = allowedDecisionFor(["history.complete"]);
    const payload = buildMinimalPayload(decision, snapshot, { now: T0 });
    expect(payload.sections).toHaveLength(0);
    expect(payload.historyMode).toBe("complete");
  });

  it("keeps observation payloads textual with no capture fields", () => {
    const { decision } = allowedDecisionFor(["observations.eating"]);
    const payload = buildMinimalPayload(decision, snapshot, { now: T0 });
    const fields = payload.sections[0]?.fields as {
      observations: Array<Record<string, unknown>>;
    };
    expect(fields.observations[0]).toMatchObject({
      date: "2026-11-17",
      summary: "18-minute meal, 1.1 bites/sec",
    });
    expect(Object.keys(fields.observations[0] ?? {})).not.toContain("frame");
  });

  it("describes payloads without exposing values", () => {
    const { decision } = allowedDecisionFor(["body.weight_goals", "lifestyle.sleep_hydration_activity"]);
    const description = describePayload(buildMinimalPayload(decision, snapshot, { now: T0 }));
    expect(description.categories).toEqual([
      "body.weight_goals",
      "lifestyle.sleep_hydration_activity",
    ]);
    expect(JSON.stringify(description)).not.toContain("82");
  });
});

describe("raw capture detection", () => {
  it("flags binary values", () => {
    expect(findRawCapture({ nested: new Uint8Array([1, 2, 3]) })[0]?.reason).toBe(
      "binary-value",
    );
  });

  it("flags data URLs", () => {
    expect(findRawCapture({ image: "data:image/png;base64,AAAA" })[0]?.reason).toBe(
      "data-url",
    );
  });

  it("flags suspicious capture keys with content", () => {
    expect(findRawCapture({ cameraFrame: "…" })[0]?.reason).toBe("suspicious-key");
  });

  it("allows ordinary observation summaries", () => {
    expect(findRawCapture({ summary: "8 posture breaks", metrics: { breaks: 8 } })).toEqual(
      [],
    );
  });
});

describe("provider resolution", () => {
  it("does not silently switch providers", () => {
    expect(resolveActiveProvider([provider], "openai")).toBeNull();
    const other = { ...provider, providerId: "openai" as const, locality: "remote" as const };
    expect(resolveActiveProvider([provider, other], "openai")?.providerId).toBe("openai");
  });
});

class RecordingTransport implements AiTransport {
  calls: Parameters<AiTransport["send"]>[0][] = [];

  async send(request: Parameters<AiTransport["send"]>[0]) {
    this.calls.push(request);
    return { text: "ok", model: request.provider.model };
  }
}

describe("AI request pipeline", () => {
  const create = async (options: { fail?: boolean } = {}) => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    const transport: AiTransport = {
      send: vi.fn(async (request) => {
        if (options.fail) throw new Error("network down");
        return { text: `answer:${request.payload.totalRecords}`, model: request.provider.model };
      }),
    };
    const transmissions: TransmissionRecord[] = [];
    const pipeline = new AiRequestPipeline({
      consent: service,
      providers: () => [provider],
      transport,
      now: () => T0,
      requestIdFactory: () => "req_test",
      onTransmission: (record) => transmissions.push(record),
    });
    return { store, service, transport, pipeline, transmissions };
  };

  const input = {
    taskId: "daily-summary",
    purpose: "daily-coaching" as const,
    providerId: "ollama" as const,
    requestedCategories: ["body.weight_goals"] as const,
    data: snapshot,
  };

  it("blocks before transport when consent is missing", async () => {
    const { pipeline, transport } = await create();
    const result = await pipeline.complete(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("consent-missing");
      expect(result.error.message).toContain("AI data-sharing permission is not enabled");
    }
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("sends only after a grant and reports transmission metadata", async () => {
    const { pipeline, service, transport, transmissions } = await create();
    await service.grant({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprintValue,
    });
    const result = await pipeline.complete(input);
    expect(result.ok).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.transmission.categories).toEqual(["body.weight_goals"]);
      expect(result.transmission.providerLocality).toBe("device");
      expect(result.transmission.estimatedBytes).toBeGreaterThan(0);
    }
    expect(transmissions).toHaveLength(1);
  });

  it("stops sending immediately after revocation", async () => {
    const { pipeline, service, transport } = await create();
    await service.grant({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprintValue,
    });
    expect((await pipeline.complete(input)).ok).toBe(true);
    await service.revoke({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
    });
    const blocked = await pipeline.complete(input);
    expect(blocked.ok).toBe(false);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("requires explicit confirmation for observation tasks even with consent", async () => {
    const { pipeline, service, transport } = await create();
    await service.grant({
      category: "observations.eating",
      providerId: "ollama",
      purpose: "observation-review",
      providerFingerprint: providerFingerprintValue,
    });
    const request = {
      taskId: "observation-review",
      purpose: "observation-review" as const,
      providerId: "ollama" as const,
      requestedCategories: ["observations.eating"] as const,
      data: snapshot,
    };
    const preview = await pipeline.complete(request);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error.code).toBe("confirmation-required");
    expect(transport.send).not.toHaveBeenCalled();

    const confirmed = await pipeline.complete({ ...request, confirmed: true });
    expect(confirmed.ok).toBe(true);
  });

  it("preview returns disclosures without transmitting", async () => {
    const { pipeline, service, transport } = await create();
    await service.grant({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprintValue,
    });
    const preview = await pipeline.preview(input);
    expect(preview.decision.allowed).toBe(true);
    expect(preview.description?.categories).toEqual(["body.weight_goals"]);
    expect(preview.decision.disclosures.join(" ")).toContain("runs on this device");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("returns a structured safe error when transport fails", async () => {
    const { pipeline, service } = await create({ fail: true });
    await service.grant({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprintValue,
    });
    const result = await pipeline.complete(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("transport-failed");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).not.toContain("network down");
    }
  });

  it("audits allowed and blocked attempts without payload content", async () => {
    const { pipeline, service } = await create();
    await pipeline.complete(input);
    await service.grant({
      category: "body.weight_goals",
      providerId: "ollama",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprintValue,
    });
    await pipeline.complete(input);
    const state = await service.getState();
    const actions = state.auditLog.map((entry) => entry.action);
    expect(actions).toContain("ai-request-blocked");
    expect(actions).toContain("ai-request-allowed");
    const serialized = JSON.stringify(state.auditLog);
    expect(serialized).not.toContain("lunch");
    expect(serialized).not.toContain('"kg"');
    expect(serialized).not.toContain('"meals"');
  });

  it("requires external access for remote providers", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    const remote: ProviderConfiguration = {
      providerId: "openai",
      model: "gpt-5-mini",
      locality: "remote",
      configuredAt: T0,
      status: "active",
    };
    const transport = { send: vi.fn(async () => ({ text: "ok" })) };
    const pipeline = new AiRequestPipeline({
      consent: service,
      providers: () => [remote],
      transport,
      now: () => T0,
    });
    await service.grant({
      category: "body.weight_goals",
      providerId: "openai",
      purpose: "daily-coaching",
      providerFingerprint: providerFingerprint(remote),
    });
    const blocked = await pipeline.complete({ ...input, providerId: "openai" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("external-access-disabled");
    expect(transport.send).not.toHaveBeenCalled();

    await service.setExternalAccess({ providerId: "openai", enabled: true });
    const allowed = await pipeline.complete({ ...input, providerId: "openai" });
    expect(allowed.ok).toBe(true);
  });
});

describe("state immutability", () => {
  it("does not mutate the state passed to applyGrant", () => {
    const state = createInitialConsentState();
    const next = applyExternalAccess(
      applyGrant(state, {
        category: "personal.profile",
        providerId: "ollama",
        purpose: "daily-coaching",
        providerFingerprint: providerFingerprintValue,
        at: T0,
      }),
      { providerId: "ollama", enabled: true, at: T0 },
    );
    expect(state.grants).toHaveLength(0);
    expect(next.grants).toHaveLength(1);
  });
});
