import { describe, expect, it } from "vitest";
import {
  CONSENT_POLICY_VERSION,
  ConsentService,
  InMemoryConsentStore,
  MESSAGES,
  applyExternalAccess,
  applyGrant,
  createInitialConsentState,
  evaluateConsent,
  getConsentStatus,
  hasValidConsent,
  providerFingerprint,
  type ConsentState,
  type ProviderConfiguration,
  type ProviderId,
} from "../src/index.js";

const T0 = "2026-11-17T09:00:00.000Z";
const T1 = "2026-11-17T09:05:00.000Z";

function remoteProvider(
  overrides: Partial<ProviderConfiguration> = {},
): ProviderConfiguration {
  return {
    providerId: "openai",
    model: "gpt-5-mini",
    locality: "remote",
    configuredAt: T0,
    status: "active",
    ...overrides,
  };
}

function localProvider(
  overrides: Partial<ProviderConfiguration> = {},
): ProviderConfiguration {
  return {
    providerId: "ollama",
    model: "llama3.2",
    locality: "device",
    configuredAt: T0,
    status: "active",
    ...overrides,
  };
}

function providerConfigFor(providerId: ProviderId): ProviderConfiguration {
  if (providerId === "ollama") return localProvider();
  if (providerId === "lmstudio") {
    return localProvider({ providerId: "lmstudio", model: "local-model" });
  }
  if (providerId === "openai-compatible") {
    return remoteProvider({
      providerId: "openai-compatible",
      locality: "local-network",
      model: "self-hosted",
    });
  }
  return remoteProvider({ providerId });
}

function fingerprintFor(providerId: ProviderId): string {
  return providerFingerprint(providerConfigFor(providerId));
}

function granted(
  state: ConsentState,
  category: Parameters<typeof applyGrant>[1]["category"],
  providerId: Parameters<typeof applyGrant>[1]["providerId"] = "openai",
  purpose: Parameters<typeof applyGrant>[1]["purpose"] = "daily-coaching",
): ConsentState {
  return applyGrant(state, {
    category,
    providerId,
    purpose,
    providerFingerprint: fingerprintFor(providerId),
    at: T0,
  });
}

async function grantVia(
  service: ConsentService,
  providerId: ProviderId,
  category: Parameters<typeof applyGrant>[1]["category"],
  purpose: Parameters<typeof applyGrant>[1]["purpose"] = "daily-coaching",
): Promise<ConsentState> {
  return service.grant({
    category,
    providerId,
    purpose,
    providerFingerprint: fingerprintFor(providerId),
  });
}

const baseRequest = {
  taskId: "daily-summary",
  purpose: "daily-coaching" as const,
  providerId: "openai" as const,
  requestedCategories: ["body.weight_goals"] as const,
};

describe("default state", () => {
  it("starts with every permission off and no external access", () => {
    const state = createInitialConsentState();
    expect(state.grants).toHaveLength(0);
    expect(state.externalAccess).toHaveLength(0);
    expect(state.policyVersion).toBe(CONSENT_POLICY_VERSION);
  });

  it("treats a configured provider as configured but unauthorized", () => {
    const decision = evaluateConsent({
      state: createInitialConsentState(),
      provider: localProvider(),
      request: {
        ...baseRequest,
        providerId: "ollama",
        requestedCategories: ["personal.profile", "body.weight_goals"],
      },
      now: T0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("consent-missing");
    expect(decision.message).toBe(MESSAGES.consentMissing);
  });
});

describe("provider configuration is not consent", () => {
  it("does not authorize any category just because a provider exists", () => {
    const state = createInitialConsentState();
    for (const category of [
      "personal.profile",
      "body.weight_goals",
      "nutrition.meal_history",
    ] as const) {
      expect(hasValidConsent(state, category, "ollama", "daily-coaching")).toBe(false);
    }
  });

  it("returns the exact no-provider message when none is configured", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals", "openai");
    const decision = evaluateConsent({
      state: applyExternalAccess(state, {
        providerId: "openai",
        enabled: true,
        at: T0,
      }),
      provider: null,
      request: baseRequest,
      now: T0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("no-provider");
    expect(decision.message).toBe(MESSAGES.noProvider);
  });

  it("never falls back to another provider when the requested one is missing", () => {
    const state = createInitialConsentState();
    const decision = evaluateConsent({
      state,
      provider: null,
      request: { ...baseRequest, providerId: "anthropic" },
      now: T0,
    });
    expect(decision.code).toBe("no-provider");
    expect(decision.providerId).toBe("anthropic");
  });
});

describe("granular consent", () => {
  it("granting one category does not authorize another", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals", "ollama");
    const decision = evaluateConsent({
      state,
      provider: localProvider(),
      request: {
        ...baseRequest,
        providerId: "ollama",
        requestedCategories: ["body.weight_goals", "nutrition.meal_history"],
      },
      now: T0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("consent-missing");
    expect(decision.missingCategories).toEqual(["nutrition.meal_history"]);
    expect(decision.grantedCategories).toEqual(["body.weight_goals"]);
  });

  it("scopes consent to the provider", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals", "ollama");
    const decision = evaluateConsent({
      state,
      provider: localProvider({ providerId: "lmstudio", model: "local-model" }),
      request: { ...baseRequest, providerId: "lmstudio" },
      now: T0,
    });
    expect(decision.code).toBe("consent-missing");
  });

  it("fingerprints endpoints without leaking them", () => {
    const base = localProvider({ endpoint: "http://127.0.0.1:11434" });
    const moved = localProvider({ endpoint: "http://192.168.1.20:11434" });
    const first = providerFingerprint(base);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain("127.0.0.1");
    expect(first).not.toBe(providerFingerprint(moved));
  });

  it("invalidates grants when the provider configuration changes", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals", "ollama");
    const changed = localProvider({ model: "llama3.3" });
    const decision = evaluateConsent({
      state,
      provider: changed,
      request: { ...baseRequest, providerId: "ollama" },
      now: T1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("consent-missing");
    expect(decision.changedCategories).toEqual(["body.weight_goals"]);
    expect(
      getConsentStatus(
        state,
        "body.weight_goals",
        "ollama",
        "daily-coaching",
        providerFingerprint(changed),
      ).status,
    ).toBe("provider-changed");
  });

  it("scopes consent to the purpose", () => {
    const state = granted(
      createInitialConsentState(),
      "body.weight_goals",
      "ollama",
      "daily-coaching",
    );
    const decision = evaluateConsent({
      state,
      provider: localProvider(),
      request: {
        taskId: "weight-trend-explainer",
        purpose: "weight-trend-explanation",
        providerId: "ollama",
        requestedCategories: ["body.weight_goals"],
      },
      now: T0,
    });
    expect(decision.code).toBe("consent-missing");
  });

  it("invalidates grants minted under an older policy version", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals", "ollama");
    const oldState: ConsentState = {
      ...state,
      policyVersion: "2025-01-01.1",
    };
    const status = getConsentStatus(oldState, "body.weight_goals", "ollama", "daily-coaching");
    expect(status.status).toBe("policy-outdated");

    const decision = evaluateConsent({
      state: oldState,
      provider: localProvider(),
      request: { ...baseRequest, providerId: "ollama" },
      now: T0,
    });
    expect(decision.code).toBe("consent-missing");
    expect(decision.outdatedCategories).toEqual(["body.weight_goals"]);
  });
});

describe("external provider access", () => {
  it("blocks remote providers until external access is enabled", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals");
    const decision = evaluateConsent({
      state,
      provider: remoteProvider(),
      request: baseRequest,
      now: T0,
    });
    expect(decision.code).toBe("external-access-disabled");
    expect(decision.missingCategories).toHaveLength(0);
  });

  it("allows a remote request once both consent layers exist", () => {
    const state = applyExternalAccess(
      granted(createInitialConsentState(), "body.weight_goals"),
      { providerId: "openai", enabled: true, at: T1 },
    );
    const decision = evaluateConsent({
      state,
      provider: remoteProvider(),
      request: baseRequest,
      now: T1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("allowed");
  });

  it("does not require external access for on-device models", () => {
    const state = granted(
      createInitialConsentState(),
      "body.weight_goals",
      "ollama",
      "daily-coaching",
    );
    const decision = evaluateConsent({
      state,
      provider: localProvider(),
      request: {
        ...baseRequest,
        providerId: "ollama",
      },
      now: T1,
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not require external access for local-network endpoints but still requires consent", () => {
    const provider = remoteProvider({
      providerId: "openai-compatible",
      locality: "local-network",
    });
    const withoutConsent = evaluateConsent({
      state: createInitialConsentState(),
      provider,
      request: {
        ...baseRequest,
        providerId: "openai-compatible",
        requestedCategories: ["personal.profile", "body.weight_goals"],
      },
      now: T1,
    });
    expect(withoutConsent.code).toBe("external-access-disabled");

    const withAccess = applyExternalAccess(createInitialConsentState(), {
      providerId: "openai-compatible",
      enabled: true,
      at: T1,
    });
    const stillNoConsent = evaluateConsent({
      state: withAccess,
      provider,
      request: {
        ...baseRequest,
        providerId: "openai-compatible",
        requestedCategories: ["personal.profile", "body.weight_goals"],
      },
      now: T1,
    });
    expect(stillNoConsent.code).toBe("consent-missing");
  });
});

describe("sensitive categories and history", () => {
  it("requires per-request confirmation for observation categories", () => {
    const state = granted(
      createInitialConsentState(),
      "observations.breathing",
      "ollama",
      "observation-review",
    );
    const request = {
      taskId: "observation-review",
      purpose: "observation-review" as const,
      providerId: "ollama" as const,
      requestedCategories: ["observations.breathing"] as const,
    };
    const unconfirmed = evaluateConsent({
      state,
      provider: localProvider(),
      request,
      now: T1,
    });
    expect(unconfirmed.code).toBe("confirmation-required");
    expect(unconfirmed.allowed).toBe(false);

    const confirmed = evaluateConsent({
      state,
      provider: localProvider(),
      request: { ...request, confirmed: true },
      now: T1,
    });
    expect(confirmed.allowed).toBe(true);
    expect(confirmed.confirmed).toBe(true);
  });

  it("blocks complete history until confirmed and flagged as complete mode", () => {
    const state = granted(
      createInitialConsentState(),
      "history.complete",
      "ollama",
      "general-assistant",
    );
    const request = {
      taskId: "general-assistant",
      purpose: "general-assistant" as const,
      providerId: "ollama" as const,
      requestedCategories: ["history.complete"] as const,
    };
    const unconfirmed = evaluateConsent({
      state,
      provider: localProvider(),
      request,
      now: T1,
    });
    expect(unconfirmed.code).toBe("confirmation-required");

    const confirmed = evaluateConsent({
      state,
      provider: localProvider(),
      request: { ...request, confirmed: true },
      now: T1,
    });
    expect(confirmed.allowed).toBe(true);
    expect(confirmed.historyMode).toBe("complete");
  });

  it("blocks raw media outright", () => {
    const state = applyExternalAccess(
      granted(createInitialConsentState(), "personal.profile"),
      { providerId: "openai", enabled: true, at: T1 },
    );
    const decision = evaluateConsent({
      state,
      provider: remoteProvider(),
      request: {
        ...baseRequest,
        requestedCategories: ["personal.profile", "body.weight_goals"],
        containsRawMedia: true,
      },
      now: T1,
    });
    expect(decision.code).toBe("raw-media-blocked");
  });
});

describe("task and purpose ceilings", () => {
  it("rejects unknown tasks", () => {
    const decision = evaluateConsent({
      state: createInitialConsentState(),
      provider: localProvider(),
      request: {
        taskId: "exfiltrate-everything",
        purpose: "daily-coaching",
        providerId: "ollama",
        requestedCategories: [],
      },
      now: T1,
    });
    expect(decision.code).toBe("unknown-task");
  });

  it("rejects a purpose that does not match the task", () => {
    const state = granted(createInitialConsentState(), "body.weight_goals");
    const decision = evaluateConsent({
      state,
      provider: remoteProvider(),
      request: { ...baseRequest, purpose: "nutrition-review" },
      now: T1,
    });
    expect(decision.code).toBe("purpose-mismatch");
  });

  it("requires the categories a task declares as required", () => {
    const state = granted(createInitialConsentState(), "personal.profile", "ollama", "daily-coaching");
    const decision = evaluateConsent({
      state,
      provider: localProvider(),
      request: {
        taskId: "daily-summary",
        purpose: "daily-coaching",
        providerId: "ollama",
        requestedCategories: ["personal.profile"],
      },
      now: T1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("required-data-missing");
    expect(decision.message).toContain("Weight history and goals");
  });

  it("requires at least one category for observation review", () => {
    const decision = evaluateConsent({
      state: createInitialConsentState(),
      provider: localProvider(),
      request: {
        taskId: "observation-review",
        purpose: "observation-review",
        providerId: "ollama",
        requestedCategories: [],
      },
      now: T1,
    });
    expect(decision.code).toBe("required-data-missing");
  });

  it("allows a context-free general assistant request", () => {
    const decision = evaluateConsent({
      state: createInitialConsentState(),
      provider: localProvider(),
      request: {
        taskId: "general-assistant",
        purpose: "general-assistant",
        providerId: "ollama",
        requestedCategories: [],
      },
      now: T1,
    });
    expect(decision.allowed).toBe(true);
  });

  it("rejects categories outside the task allow-list", () => {
    const state = granted(
      createInitialConsentState(),
      "observations.eating",
      "openai",
      "daily-coaching",
    );
    const decision = evaluateConsent({
      state,
      provider: remoteProvider(),
      request: {
        ...baseRequest,
        requestedCategories: ["observations.eating"],
        confirmed: true,
      },
      now: T1,
    });
    expect(decision.code).toBe("category-not-allowed");
  });
});

describe("consent service lifecycle", () => {
  it("records timestamps and policy versions for grants and revocations", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    await grantVia(service, "openai", "body.weight_goals");

    let state = await service.getState();
    expect(state.grants).toHaveLength(1);
    expect(state.grants[0]?.grantedAt).toBe(T0);
    expect(state.grants[0]?.policyVersion).toBe(CONSENT_POLICY_VERSION);
    expect(state.auditLog.at(-1)?.action).toBe("granted");

    const revoked = await new ConsentService(store, { now: () => T1 }).revoke({
      category: "body.weight_goals",
      providerId: "openai",
      purpose: "daily-coaching",
    });
    expect(revoked.grants[0]?.revokedAt).toBe(T1);
    expect(hasValidConsent(revoked, "body.weight_goals", "openai", "daily-coaching")).toBe(
      false,
    );
    expect(revoked.auditLog.at(-1)?.action).toBe("revoked");
  });

  it("revocation immediately blocks subsequent evaluations", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    const state = await grantVia(service, "openai", "body.weight_goals");
    const withAccess = applyExternalAccess(state, {
      providerId: "openai",
      enabled: true,
      at: T0,
    });
    await store.save(withAccess);

    expect(
      evaluateConsent({
        state: await service.getState(),
        provider: remoteProvider(),
        request: baseRequest,
        now: T0,
      }).allowed,
    ).toBe(true);

    await service.revoke({
      category: "body.weight_goals",
      providerId: "openai",
      purpose: "daily-coaching",
    });

    expect(
      evaluateConsent({
        state: await service.getState(),
        provider: remoteProvider(),
        request: baseRequest,
        now: T0,
      }).code,
    ).toBe("consent-missing");
  });

  it("replaces an earlier grant instead of leaving two active grants", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    await grantVia(service, "openai", "body.weight_goals");
    const state = await grantVia(
      new ConsentService(store, { now: () => T1 }),
      "openai",
      "body.weight_goals",
    );
    const active = state.grants.filter((grant) => grant.revokedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]?.grantedAt).toBe(T1);
  });

  it("upgrades the policy version on load so stale grants stop working", async () => {
    const stale = createInitialConsentState("2024-01-01.1");
    const staleGranted = applyGrant(stale, {
      category: "body.weight_goals",
      providerId: "openai",
      purpose: "daily-coaching",
      providerFingerprint: fingerprintFor("openai"),
      at: T0,
      policyVersion: "2024-01-01.1",
    });
    const store = new InMemoryConsentStore(staleGranted);
    const service = new ConsentService(store, { now: () => T1 });
    const state = await service.getState();
    expect(state.policyVersion).toBe(CONSENT_POLICY_VERSION);
    expect(
      getConsentStatus(state, "body.weight_goals", "openai", "daily-coaching").status,
    ).toBe("policy-outdated");
    expect(state.auditLog.at(-1)?.action).toBe("policy-version-changed");
  });

  it("revokeAll clears every grant but leaves external access untouched", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    await grantVia(service, "openai", "body.weight_goals");
    await grantVia(service, "ollama", "personal.profile");
    await service.setExternalAccess({ providerId: "openai", enabled: true });
    const state = await service.revokeAll();
    expect(state.grants.every((grant) => grant.revokedAt !== null)).toBe(true);
    expect(state.externalAccess[0]?.enabled).toBe(true);
  });

  it("never puts payload data into the audit log", async () => {
    const store = new InMemoryConsentStore();
    const service = new ConsentService(store, { now: () => T0 });
    const state = await grantVia(service, "openai", "body.weight_goals");
    const serialized = JSON.stringify(state.auditLog);
    expect(serialized).not.toContain("kg");
    expect(serialized).not.toContain("meal");
  });
});
