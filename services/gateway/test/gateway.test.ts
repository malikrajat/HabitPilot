import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MESSAGES, type AiPayload } from "@habitpilot/consent-core";
import { buildGateway } from "../src/server.js";
import { ServerConsentDatabase } from "../src/consentStore.js";
import { issueSessionToken } from "../src/auth.js";
import type { GatewayConfig } from "../src/config.js";
import type { ProviderInvoker } from "../src/providerClient.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const USER = "user-1";
const API_KEY = "test-only-provider-credential";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    sessionSecret: SECRET,
    provider: {
      providerId: "openai",
      model: "gpt-test",
      locality: "remote",
      apiKey: API_KEY,
      baseUrl: "https://api.openai.test/v1",
    },
    allowedOrigins: ["http://localhost:5173"],
    rateLimit: { maxRequests: 100, windowMs: 60_000, consentMaxRequests: 200 },
    ...overrides,
  };
}

interface Harness {
  app: FastifyInstance;
  database: ServerConsentDatabase;
  invoker: ReturnType<typeof vi.fn>;
  token: string;
  headers: Record<string, string>;
}

const openApps: FastifyInstance[] = [];

async function harness(options: {
  config?: Partial<GatewayConfig>;
  now?: () => number;
} = {}): Promise<Harness> {
  const database = await ServerConsentDatabase.open();
  const invoker = vi.fn<ProviderInvoker>(async ({ payload }) => ({
    text: `answer-with-${payload.sections.length}-sections`,
    model: "gpt-test",
  }));
  const app = await buildGateway({
    config: config(options.config),
    database,
    invoker,
    ...(options.now ? { now: options.now } : {}),
  });
  openApps.push(app);
  const token = issueSessionToken(
    { sub: USER, exp: Math.floor(Date.now() / 1000) + 3600, scopes: ["ai", "consent"] },
    SECRET,
  );
  return { app, database, invoker, token, headers: { authorization: `Bearer ${token}` } };
}

async function grant(
  h: Harness,
  category: string,
  purpose = "daily-coaching",
): Promise<void> {
  const response = await h.app.inject({
    method: "POST",
    url: "/v1/consent/grant",
    headers: h.headers,
    payload: { category, purpose },
  });
  expect(response.statusCode).toBe(200);
}

async function enableAccess(h: Harness): Promise<void> {
  const response = await h.app.inject({
    method: "POST",
    url: "/v1/consent/external-access",
    headers: h.headers,
    payload: { enabled: true },
  });
  expect(response.statusCode).toBe(200);
}

async function authorize(h: Harness, payload: unknown) {
  return h.app.inject({
    method: "POST",
    url: "/v1/ai/authorize",
    headers: h.headers,
    payload,
  });
}

async function complete(h: Harness, approvalToken: string, payload: unknown) {
  return h.app.inject({
    method: "POST",
    url: "/v1/ai/complete",
    headers: h.headers,
    payload: { ...(payload as Record<string, unknown>), approvalToken },
  });
}

async function approve(
  h: Harness,
  payload: unknown,
): Promise<{ token: string; response: Awaited<ReturnType<typeof authorize>> }> {
  const response = await authorize(h, payload);
  expect(response.statusCode).toBe(200);
  const token = response.json().approvalToken as string;
  expect(token).toBeTruthy();
  return { token, response };
}

const dailyRequest = {
  taskId: "daily-summary",
  purpose: "daily-coaching",
  requestedCategories: ["body.weight_goals"],
  data: {
    weight: {
      entries: [
        { date: "2026-11-10", kg: 84.2 },
        { date: "2026-11-17", kg: 83.4 },
      ],
      goal: { targetWeightKg: 78 },
    },
  },
};

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("gateway authentication", () => {
  it("serves health without auth", async () => {
    const { app } = await harness();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("rejects missing and tampered tokens", async () => {
    const { app, headers } = await harness();
    expect((await app.inject({ method: "GET", url: "/v1/consent" })).statusCode).toBe(401);
    const tampered = await app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: { authorization: `${headers.authorization}x` },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it("revokes the current session token", async () => {
    const h = await harness();
    const revoke = await h.app.inject({
      method: "POST",
      url: "/v1/session/revoke",
      headers: h.headers,
    });
    expect(revoke.statusCode).toBe(200);
    const after = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: h.headers,
    });
    expect(after.statusCode).toBe(401);
  });

  it("rotates a session token and invalidates the old one", async () => {
    const h = await harness();
    const refresh = await h.app.inject({
      method: "POST",
      url: "/v1/session/refresh",
      headers: h.headers,
    });
    expect(refresh.statusCode).toBe(200);
    const nextToken = refresh.json().token as string;
    expect(nextToken).toBeTruthy();

    const oldToken = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: h.headers,
    });
    expect(oldToken.statusCode).toBe(401);

    const newToken = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: { authorization: `Bearer ${nextToken}` },
    });
    expect(newToken.statusCode).toBe(200);
  });

  it("accepts a previous secret during rotation", async () => {
    const previous = "previous-secret-that-is-long-enough-0987654321";
    const h = await harness({ config: { sessionSecretPrevious: previous } });
    const oldToken = issueSessionToken(
      { sub: USER, exp: Math.floor(Date.now() / 1000) + 600, scopes: ["ai", "consent"] },
      previous,
    );
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("rate limits consent endpoints", async () => {
    const h = await harness({
      config: { rateLimit: { maxRequests: 100, windowMs: 60_000, consentMaxRequests: 2 } },
    });
    for (let index = 0; index < 2; index += 1) {
      expect(
        (
          await h.app.inject({
            method: "GET",
            url: "/v1/consent",
            headers: h.headers,
          })
        ).statusCode,
      ).toBe(200);
    }
    const limited = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: h.headers,
    });
    expect(limited.statusCode).toBe(429);
  });

  it("rejects tokens without the ai scope", async () => {
    const { app } = await harness();
    const token = issueSessionToken(
      { sub: USER, exp: Math.floor(Date.now() / 1000) + 600, scopes: ["consent"] },
      SECRET,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers: { authorization: `Bearer ${token}` },
      payload: dailyRequest,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("insufficient-scope");
  });
});

describe("server-side consent enforcement", () => {
  it("reports no provider when unconfigured", async () => {
    const { app, headers } = await harness({ config: { provider: null } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers,
      payload: dailyRequest,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toBe(MESSAGES.noProvider);
  });

  it("blocks with the exact consent message and never invokes the provider", async () => {
    const h = await harness();
    const { app, headers, invoker } = h;
    await app.inject({
      method: "POST",
      url: "/v1/consent/external-access",
      headers,
      payload: { enabled: true },
    });
    const response = await authorize(h, dailyRequest);
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error.code).toBe("consent-missing");
    expect(body.error.message).toBe(MESSAGES.consentMissing);
    expect(body.error.missingCategories).toEqual(["body.weight_goals"]);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("ignores client-claimed consent flags", async () => {
    const { app, headers, invoker } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers,
      payload: { ...dailyRequest, consentGranted: true, allowed: true, externalAccess: true },
    });
    expect(response.statusCode).toBe(403);
    expect(invoker).not.toHaveBeenCalled();
  });

  it("requires server-side external access for remote providers", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    const blocked = await authorize(h, dailyRequest);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("external-access-disabled");

    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    const allowed = await complete(h, token, dailyRequest);
    expect(allowed.statusCode).toBe(200);
    expect(h.invoker).toHaveBeenCalledTimes(1);
  });

  it("enforces consent granted for one user on another user's request", async () => {
    const { app } = await harness();
    const owner = issueSessionToken(
      { sub: "owner", exp: Math.floor(Date.now() / 1000) + 3600, scopes: ["ai", "consent"] },
      SECRET,
    );
    const other = issueSessionToken(
      { sub: "other", exp: Math.floor(Date.now() / 1000) + 3600, scopes: ["ai", "consent"] },
      SECRET,
    );
    for (const token of [owner, other]) {
      await app.inject({
        method: "POST",
        url: "/v1/consent/external-access",
        headers: { authorization: `Bearer ${token}` },
        payload: { enabled: true },
      });
    }
    await app.inject({
      method: "POST",
      url: "/v1/consent/grant",
      headers: { authorization: `Bearer ${owner}` },
      payload: { category: "body.weight_goals", purpose: "daily-coaching" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers: { authorization: `Bearer ${other}` },
      payload: dailyRequest,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("consent-missing");
  });

  it("stops immediately after revocation", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    expect((await complete(h, token, dailyRequest)).statusCode).toBe(200);

    await h.app.inject({
      method: "POST",
      url: "/v1/consent/revoke",
      headers: h.headers,
      payload: { category: "body.weight_goals", purpose: "daily-coaching" },
    });

    const second = await authorize(h, dailyRequest);
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe("consent-missing");
    expect(h.invoker).toHaveBeenCalledTimes(1);
  });

  it("records policy version and metadata-only audit entries", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: h.headers,
    });
    const body = response.json();
    expect(body.policyVersion).toBeTruthy();
    expect(body.grants[0].policyVersion).toBe(body.policyVersion);
    expect(body.grants[0].providerFingerprint).toBeTruthy();
    expect(body.grants[0].grantedAt).toBeTruthy();
    expect(body.auditLog[0].action).toBe("granted");

    const { token } = await approve(h, dailyRequest);
    await complete(h, token, dailyRequest);

    const after = (await h.app.inject({
      method: "GET",
      url: "/v1/consent",
      headers: h.headers,
    })).json();
    const serialized = JSON.stringify(after);
    expect(serialized).toContain("ai-request-allowed");
    expect(serialized).not.toContain("lunch");
    expect(serialized).not.toContain('"kg"');
  });
});

describe("two-phase approval", () => {
  it("requires an approval token before accepting data", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const response = await complete(h, "", dailyRequest);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid-request");
    expect(h.invoker).not.toHaveBeenCalled();
  });

  it("does not transmit data during authorization", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { response } = await approve(h, dailyRequest);
    expect(h.invoker).not.toHaveBeenCalled();
    const body = response.body;
    expect(body).not.toContain("83.4");
    expect(body).not.toContain("lunch");
    expect(response.json().approvalToken).toBeTruthy();
    expect(response.json().decision.allowed).toBe(true);
  });

  it("makes approvals single-use", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    expect((await complete(h, token, dailyRequest)).statusCode).toBe(200);

    const replay = await complete(h, token, dailyRequest);
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.code).toBe("approval-required");
    expect(h.invoker).toHaveBeenCalledTimes(1);
  });

  it("rejects a token used with different categories", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    const response = await complete(h, token, {
      ...dailyRequest,
      requestedCategories: ["body.weight_goals", "personal.profile"],
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("approval-required");
  });

  it("rejects health categories that were not approved for this task", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    // The token only covers weight; sending nutrition is rejected at the boundary.
    const response = await complete(h, token, {
      ...dailyRequest,
      data: {
        ...dailyRequest.data,
        nutrition: { meals: [{ date: "2026-11-17", label: "lunch", kcal: 620 }] },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("unrequested-data");
    expect(h.invoker).not.toHaveBeenCalled();
  });

  it("re-checks consent after authorization and before transmission", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);

    await h.app.inject({
      method: "POST",
      url: "/v1/consent/revoke",
      headers: h.headers,
      payload: { category: "body.weight_goals", purpose: "daily-coaching" },
    });

    const response = await complete(h, token, dailyRequest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("consent-missing");
    expect(h.invoker).not.toHaveBeenCalled();
  });

  it("expires approval tokens", async () => {
    let clock = Date.now();
    const h = await harness({ now: () => clock });
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    clock += 121_000;
    const response = await complete(h, token, dailyRequest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("approval-required");
  });

  it("requires confirmation before issuing a token for sensitive observations", async () => {
    const h = await harness();
    await grant(h, "observations.eating", "observation-review");
    await enableAccess(h);
    const request = {
      taskId: "observation-review",
      purpose: "observation-review",
      requestedCategories: ["observations.eating"],
      data: {
        observations: {
          eating: [{ date: "2026-11-17", summary: "18 minute meal", durationMinutes: 18 }],
        },
      },
    };
    const blocked = await authorize(h, request);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("confirmation-required");

    const { token } = await approve(h, { ...request, confirmed: true });
    expect((await complete(h, token, request)).statusCode).toBe(200);
  });
});

describe("request validation", () => {
  it("rejects provider switching", async () => {
    const { app, headers, invoker } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers,
      payload: { ...dailyRequest, providerId: "anthropic" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("provider-not-permitted");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("rejects categories outside the task ceiling", async () => {
    const h = await harness();
    await grant(h, "nutrition.meal_history");
    await enableAccess(h);
    const response = await authorize(h, {
      ...dailyRequest,
      requestedCategories: ["observations.breathing"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("category-not-allowed");
  });

  it("requires the categories a task declares as required", async () => {
    const h = await harness();
    await grant(h, "personal.profile");
    await enableAccess(h);
    const response = await authorize(h, {
      ...dailyRequest,
      requestedCategories: ["personal.profile"],
      data: { profile: { ageRange: "30-39" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("required-data-missing");
  });

  it("blocks raw media flags before issuing a token", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    const response = await authorize(h, { ...dailyRequest, containsRawMedia: true });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("raw-media-blocked");
    expect(h.invoker).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies with a safe error", async () => {
    const { app, headers } = await harness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers,
      payload: { taskId: 42 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid-request");
  });

  it("rate limits authorization attempts per user", async () => {
    const { app, headers } = await harness({
      config: { rateLimit: { maxRequests: 2, windowMs: 60_000, consentMaxRequests: 100 } },
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/ai/authorize",
        headers,
        payload: dailyRequest,
      });
      expect(response.statusCode).toBe(403);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/v1/ai/authorize",
      headers,
      payload: dailyRequest,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
    expect(limited.json().error.retryable).toBe(true);
  });
});

describe("payload minimization and secret handling", () => {
  it("forwards only approved categories", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    const response = await complete(h, token, dailyRequest);
    expect(response.statusCode).toBe(200);

    const invocation = h.invoker.mock.calls[0]?.[0] as { payload: AiPayload } | undefined;
    expect(invocation?.payload.sections.map((section) => section.category)).toEqual([
      "body.weight_goals",
    ]);
    const serialized = JSON.stringify(invocation?.payload);
    expect(serialized).not.toContain("lunch");
    expect(serialized).not.toContain("30-39");
  });

  it("never returns or embeds provider credentials", async () => {
    const h = await harness();
    const providerInfo = await h.app.inject({
      method: "GET",
      url: "/v1/ai/provider",
      headers: h.headers,
    });
    expect(providerInfo.statusCode).toBe(200);
    expect(providerInfo.body).not.toContain(API_KEY);
    expect(providerInfo.body).not.toContain("api.openai.test");
    expect(providerInfo.json()).toMatchObject({
      configured: true,
      providerId: "openai",
      locality: "remote",
    });

    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    const response = await complete(h, token, dailyRequest);
    expect(response.body).not.toContain(API_KEY);
  });

  it("returns safe structured errors when the provider fails", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    h.invoker.mockRejectedValueOnce(new Error("upstream exploded with sk-leak"));
    const response = await complete(h, token, dailyRequest);
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("provider-error");
    expect(response.body).not.toContain("exploded");
    expect(response.body).not.toContain("sk-leak");
  });

  it("does not persist health data in the consent database", async () => {
    const h = await harness();
    await grant(h, "body.weight_goals");
    await enableAccess(h);
    const { token } = await approve(h, dailyRequest);
    await complete(h, token, dailyRequest);
    const serialized = JSON.stringify(h.database.get(USER));
    expect(serialized).not.toContain("kg");
    expect(serialized).not.toContain("lunch");
    expect(serialized).not.toContain("620");
  });

  it("sets no-store and only allows configured CORS origins", async () => {
    const { app } = await harness();
    const allowed = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "http://localhost:5173" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(allowed.headers["cache-control"]).toBe("no-store");

    const denied = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
