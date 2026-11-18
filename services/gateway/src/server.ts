import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  MESSAGES,
  buildMinimalPayload,
  evaluateConsent,
  findRawCapture,
  getAiTask,
  getProviderDefinition,
  isDataCategory,
  providerFingerprint,
  isPurposeId,
  type AiPayload,
  type ConsentDecision,
  type DataCategory,
  type HealthDataSnapshot,
  type ProviderConfiguration,
  type PurposeId,
} from "@habitpilot/consent-core";
import type { GatewayConfig, GatewayProviderRuntime } from "./config.js";
import {
  SessionRegistry,
  extractBearerToken,
  issueSessionToken,
  verifySessionToken,
  type SessionClaims,
} from "./auth.js";
import { RateLimiter } from "./rateLimit.js";
import { ServerConsentDatabase } from "./consentStore.js";
import { createHttpProviderInvoker, type ProviderInvoker } from "./providerClient.js";
import { ApprovalStore } from "./approvals.js";

export interface GatewayDependencies {
  readonly config: GatewayConfig;
  readonly database?: ServerConsentDatabase;
  readonly invoker?: ProviderInvoker;
  readonly approvals?: ApprovalStore;
  readonly sessions?: SessionRegistry;
  readonly now?: () => number;
  readonly logger?: boolean;
}

type Body = Record<string, unknown>;

function asRecord(value: unknown): Body | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Body)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

function asStringArray(value: unknown, max = 24): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extras: Record<string, unknown> = {},
): FastifyReply {
  return reply.code(status).send({
    error: {
      code,
      message,
      retryable: false,
      ...extras,
    },
  });
}

function statusForDecision(decision: ConsentDecision): number {
  switch (decision.code) {
    case "no-provider":
    case "provider-disabled":
      return 503;
    case "unknown-task":
    case "purpose-mismatch":
    case "category-not-allowed":
    case "required-data-missing":
    case "invalid-request":
      return 400;
    case "raw-media-blocked":
      return 422;
    default:
      return 403;
  }
}

function fullDecisionBody(decision: ConsentDecision): Record<string, unknown> {
  return {
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message,
    taskId: decision.taskId,
    purpose: decision.purpose,
    providerId: decision.providerId,
    providerLocality: decision.providerLocality,
    policyVersion: decision.policyVersion,
    requestedCategories: decision.requestedCategories,
    grantedCategories: decision.grantedCategories,
    missingCategories: decision.missingCategories,
    outdatedCategories: decision.outdatedCategories,
    changedCategories: decision.changedCategories,
    disclosures: decision.disclosures,
    requiresConfirmation: decision.requiresConfirmation,
    confirmed: decision.confirmed,
    historyMode: decision.historyMode,
    evaluatedAt: decision.evaluatedAt,
  };
}

function sameCategories(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return right.every((category) => leftSet.has(category));
}

function findUnrequestedCategories(
  snapshot: HealthDataSnapshot,
  requested: ReadonlySet<string>,
): DataCategory[] {
  const extra: DataCategory[] = [];
  if (snapshot.profile && !requested.has("personal.profile")) extra.push("personal.profile");
  if (snapshot.weight && !requested.has("body.weight_goals")) extra.push("body.weight_goals");
  if (snapshot.nutrition && !requested.has("nutrition.meal_history")) {
    extra.push("nutrition.meal_history");
  }
  if (
    snapshot.lifestyle &&
    !requested.has("lifestyle.sleep_hydration_activity")
  ) {
    extra.push("lifestyle.sleep_hydration_activity");
  }
  if (snapshot.observations?.eating && !requested.has("observations.eating")) {
    extra.push("observations.eating");
  }
  if (
    snapshot.observations?.postureEyeScreen &&
    !requested.has("observations.posture_eye_screen")
  ) {
    extra.push("observations.posture_eye_screen");
  }
  if (snapshot.observations?.breathing && !requested.has("observations.breathing")) {
    extra.push("observations.breathing");
  }
  return extra;
}

function decisionBody(decision: ConsentDecision): Record<string, unknown> {
  return {
    code: decision.code,
    message: decision.message,
    policyVersion: decision.policyVersion,
    providerId: decision.providerId,
    providerLocality: decision.providerLocality,
    requestedCategories: decision.requestedCategories,
    missingCategories: decision.missingCategories,
    outdatedCategories: decision.outdatedCategories,
    changedCategories: decision.changedCategories,
    requiresConfirmation: decision.requiresConfirmation,
    disclosures: decision.disclosures,
  };
}

function providerConfigurationFor(runtime: GatewayProviderRuntime): ProviderConfiguration {
  return {
    providerId: runtime.providerId,
    model: runtime.model,
    locality: runtime.locality,
    endpoint: runtime.baseUrl,
    configuredAt: "server-managed",
    status: "active",
  };
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record).slice(0, 20)) {
    if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function observations(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 500).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const date = asString(record["date"]);
    const summary = asString(record["summary"]);
    if (!date || !summary) return [];
    const duration = record["durationMinutes"];
    const confidence = record["confidence"];
    return [
      {
        date,
        summary,
        ...(typeof duration === "number" && Number.isFinite(duration)
          ? { durationMinutes: duration }
          : {}),
        ...(numberRecord(record["metrics"]) ? { metrics: numberRecord(record["metrics"])! } : {}),
        ...(typeof confidence === "number" && Number.isFinite(confidence)
          ? { confidence }
          : {}),
      },
    ];
  });
}

/**
 * Rebuilds the snapshot from known fields only. Unknown keys, binary captures
 * and oversized arrays are dropped before they can reach payload construction.
 */
export function sanitizeSnapshot(value: unknown): HealthDataSnapshot {
  const record = asRecord(value) ?? {};

  const profileRecord = asRecord(record["profile"]);
  const profile = profileRecord
    ? {
        ...(asString(profileRecord["ageRange"]) ? { ageRange: asString(profileRecord["ageRange"])! } : {}),
        ...(asString(profileRecord["biologicalSex"])
          ? { biologicalSex: asString(profileRecord["biologicalSex"])! }
          : {}),
        ...(typeof profileRecord["heightCm"] === "number"
          ? { heightCm: profileRecord["heightCm"] as number }
          : {}),
        ...(asString(profileRecord["activityLevel"])
          ? { activityLevel: asString(profileRecord["activityLevel"])! }
          : {}),
      }
    : undefined;

  const weightRecord = asRecord(record["weight"]);
  let weight: HealthDataSnapshot["weight"];
  if (weightRecord) {
    const entries = Array.isArray(weightRecord["entries"])
      ? weightRecord["entries"].slice(0, 1000).flatMap((entry) => {
          const item = asRecord(entry);
          const date = asString(item?.["date"]);
          const kg = item?.["kg"];
          return date && typeof kg === "number" && Number.isFinite(kg) ? [{ date, kg }] : [];
        })
      : [];
    const goalRecord = asRecord(weightRecord["goal"]);
    const targetWeightKg = goalRecord?.["targetWeightKg"];
    const targetDate = asString(goalRecord?.["targetDate"]);
    weight = {
      entries,
      ...(typeof targetWeightKg === "number" && Number.isFinite(targetWeightKg)
        ? { goal: { targetWeightKg, ...(targetDate ? { targetDate } : {}) } }
        : {}),
    };
  }

  const nutritionRecord = asRecord(record["nutrition"]);
  const meals = nutritionRecord && Array.isArray(nutritionRecord["meals"])
    ? nutritionRecord["meals"].slice(0, 1000).flatMap((entry) => {
        const item = asRecord(entry);
        if (!item) return [];
        const date = asString(item["date"]);
        const label = asString(item["label"]);
        const kcal = item["kcal"];
        if (!date || !label || typeof kcal !== "number" || !Number.isFinite(kcal)) return [];
        const numeric = (key: string) =>
          typeof item[key] === "number" && Number.isFinite(item[key])
            ? { [key]: item[key] as number }
            : {};
        return [
          {
            date,
            label,
            kcal,
            ...numeric("proteinG"),
            ...numeric("carbsG"),
            ...numeric("fatG"),
            ...numeric("durationMinutes"),
          },
        ];
      })
    : [];

  const observationsRecord = asRecord(record["observations"]);
  const observationSetRaw = observationsRecord
    ? {
        ...(observations(observationsRecord["eating"])
          ? { eating: observations(observationsRecord["eating"])! }
          : {}),
        ...(observations(observationsRecord["postureEyeScreen"])
          ? { postureEyeScreen: observations(observationsRecord["postureEyeScreen"])! }
          : {}),
        ...(observations(observationsRecord["breathing"])
          ? { breathing: observations(observationsRecord["breathing"])! }
          : {}),
      }
    : undefined;
  const observationSet =
    observationSetRaw && Object.keys(observationSetRaw).length > 0
      ? observationSetRaw
      : undefined;

  const lifestyleRecord = asRecord(record["lifestyle"]);
  const lifestyle = lifestyleRecord
    ? {
        ...(typeof lifestyleRecord["sleepHours"] === "number"
          ? { sleepHours: lifestyleRecord["sleepHours"] as number }
          : {}),
        ...(typeof lifestyleRecord["hydrationMl"] === "number"
          ? { hydrationMl: lifestyleRecord["hydrationMl"] as number }
          : {}),
        ...(typeof lifestyleRecord["steps"] === "number"
          ? { steps: lifestyleRecord["steps"] as number }
          : {}),
        ...(typeof lifestyleRecord["activeMinutes"] === "number"
          ? { activeMinutes: lifestyleRecord["activeMinutes"] as number }
          : {}),
      }
    : undefined;

  return {
    ...(profile ? { profile } : {}),
    ...(weight ? { weight } : {}),
    ...(nutritionRecord ? { nutrition: { meals } } : {}),
    ...(observationSet ? { observations: observationSet } : {}),
    ...(lifestyle ? { lifestyle } : {}),
  };
}

export async function buildGateway(dependencies: GatewayDependencies): Promise<FastifyInstance> {
  const { config } = dependencies;
  const database =
    dependencies.database ?? (await ServerConsentDatabase.open(config.consentFile));
  const invoker = dependencies.invoker ?? createHttpProviderInvoker();
  const now = dependencies.now ?? (() => Date.now());
  const approvals = dependencies.approvals ?? new ApprovalStore({ now });
  const sessionRegistry = dependencies.sessions ?? new SessionRegistry(now);
  const aiLimiter = new RateLimiter({
    maxRequests: config.rateLimit.maxRequests,
    windowMs: config.rateLimit.windowMs,
    now,
  });
  const consentLimiter = new RateLimiter({
    maxRequests: config.rateLimit.consentMaxRequests,
    windowMs: config.rateLimit.windowMs,
    now,
  });

  const enforceConsentLimit = (reply: FastifyReply, userId: string): boolean => {
    const limit = consentLimiter.check(userId);
    reply.header("X-RateLimit-Remaining", String(limit.remaining));
    if (limit.allowed) return true;
    reply.header("Retry-After", String(limit.retryAfterSeconds));
    fail(reply, 429, "rate-limited", "Too many consent changes. Try again shortly.", {
      retryable: true,
      retryAfterSeconds: limit.retryAfterSeconds,
    });
    return false;
  };

  const app = Fastify({
    logger: dependencies.logger ?? false,
    bodyLimit: 256 * 1024,
  });

  const sessions = new WeakMap<FastifyRequest, SessionClaims>();

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");

    const origin = request.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "authorization, content-type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      reply.header("Access-Control-Max-Age", "600");
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }

    if (request.url === "/healthz") return;

    const token = extractBearerToken(request.headers.authorization);
    const claims = token
      ? (verifySessionToken(token, config.sessionSecret, now()) ??
        (config.sessionSecretPrevious
          ? verifySessionToken(token, config.sessionSecretPrevious, now())
          : null))
      : null;
    if (!claims || sessionRegistry.isRevoked(claims.jti)) {
      return fail(reply, 401, "unauthorized", "A valid session token is required.");
    }
    sessions.set(request, claims);
  });

  const session = (request: FastifyRequest): SessionClaims => {
    const claims = sessions.get(request);
    if (!claims) throw new Error("Missing verified session");
    return claims;
  };

  const hasScope = (claims: SessionClaims, scope: string): boolean =>
    !claims.scopes || claims.scopes.includes(scope);

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/session/revoke", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    if (claims.jti) sessionRegistry.revoke(claims.jti, claims.exp);
    return reply.send({ ok: true });
  });

  app.post("/v1/session/refresh", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    const exp = Math.floor(now() / 1000) + 3600;
    const token = issueSessionToken(
      { sub: claims.sub, exp, scopes: claims.scopes },
      config.sessionSecret,
    );
    if (claims.jti) sessionRegistry.revoke(claims.jti, claims.exp);
    return reply.send({
      ok: true,
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  });

  app.get("/v1/ai/provider", async (request, reply) => {
    const claims = session(request);
    if (!hasScope(claims, "ai")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot use AI features.");
    }
    if (!config.provider) {
      return reply.send({ configured: false });
    }
    return reply.send({
      configured: true,
      providerId: config.provider.providerId,
      providerLabel: getProviderDefinition(config.provider.providerId).label,
      model: config.provider.model,
      locality: config.provider.locality,
      providerFingerprint: providerFingerprint(providerConfigurationFor(config.provider)),
    });
  });

  app.get("/v1/consent", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    const service = database.serviceFor(claims.sub);
    const state = await service.getState();
    return reply.send({
      policyVersion: state.policyVersion,
      providerId: config.provider?.providerId ?? null,
      providerLocality: config.provider?.locality ?? null,
      grants: state.grants,
      externalAccess: state.externalAccess,
      auditLog: state.auditLog,
    });
  });

  app.post("/v1/consent/grant", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    if (!hasScope(claims, "consent")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot change consent.");
    }
    if (!config.provider) {
      return fail(reply, 503, "no-provider", MESSAGES.noProvider);
    }
    const body = asRecord(request.body);
    if (!body) return fail(reply, 400, "invalid-request", "A JSON body is required.");

    const category = body["category"];
    const purpose = body["purpose"];
    if (!isDataCategory(category) || !isPurposeId(purpose)) {
      return fail(reply, 400, "invalid-request", "A known category and purpose are required.");
    }
    const declaredProvider = body["providerId"];
    if (declaredProvider !== undefined && declaredProvider !== config.provider.providerId) {
      return fail(
        reply,
        400,
        "provider-not-permitted",
        "Consent can only be granted for the server-configured provider.",
      );
    }

    const service = database.serviceFor(claims.sub);
    const providerConfiguration = providerConfigurationFor(config.provider);
    const state = await service.grant({
      category,
      purpose,
      providerId: config.provider.providerId,
      providerFingerprint: providerFingerprint(providerConfiguration),
    });
    return reply.send({ ok: true, policyVersion: state.policyVersion });
  });

  app.post("/v1/consent/revoke", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    if (!hasScope(claims, "consent")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot change consent.");
    }
    if (!config.provider) {
      return fail(reply, 503, "no-provider", MESSAGES.noProvider);
    }
    const body = asRecord(request.body);
    if (!body) return fail(reply, 400, "invalid-request", "A JSON body is required.");

    const category = body["category"];
    const purpose = body["purpose"];
    if (!isDataCategory(category)) {
      return fail(reply, 400, "invalid-request", "A known category is required.");
    }
    if (purpose !== undefined && !isPurposeId(purpose)) {
      return fail(reply, 400, "invalid-request", "The purpose is not recognised.");
    }

    const service = database.serviceFor(claims.sub);
    await service.revoke({
      category,
      providerId: config.provider.providerId,
      ...(purpose ? { purpose } : {}),
    });
    return reply.send({ ok: true });
  });

  app.post("/v1/consent/revoke-all", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    if (!hasScope(claims, "consent")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot change consent.");
    }
    const service = database.serviceFor(claims.sub);
    await service.revokeAll();
    return reply.send({ ok: true });
  });

  app.post("/v1/consent/external-access", async (request, reply) => {
    const claims = session(request);
    if (!enforceConsentLimit(reply, claims.sub)) return;
    if (!hasScope(claims, "consent")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot change consent.");
    }
    if (!config.provider) {
      return fail(reply, 503, "no-provider", MESSAGES.noProvider);
    }
    const body = asRecord(request.body);
    const enabled = asBoolean(body?.["enabled"]);
    if (enabled === null) {
      return fail(reply, 400, "invalid-request", "`enabled` must be a boolean.");
    }
    const service = database.serviceFor(claims.sub);
    await service.setExternalAccess({
      providerId: config.provider.providerId,
      enabled,
    });
    return reply.send({ ok: true, enabled });
  });

  app.post("/v1/ai/authorize", async (request, reply) => {
    const claims = session(request);
    if (!hasScope(claims, "ai")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot use AI features.");
    }

    const limit = aiLimiter.check(`${claims.sub}:ai-authorize`);
    reply.header("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfterSeconds));
      return fail(reply, 429, "rate-limited", "Too many AI requests. Try again shortly.", {
        retryable: true,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const runtime = config.provider;
    if (!runtime) {
      return fail(reply, 503, "no-provider", MESSAGES.noProvider);
    }

    const body = asRecord(request.body);
    if (!body) return fail(reply, 400, "invalid-request", "A JSON body is required.");

    const declaredProvider = body["providerId"];
    if (declaredProvider !== undefined && declaredProvider !== runtime.providerId) {
      return fail(
        reply,
        400,
        "provider-not-permitted",
        "The requested provider is not the one configured on this server.",
      );
    }

    const taskId = asString(body["taskId"]);
    const purpose = body["purpose"];
    const categories = asStringArray(body["requestedCategories"]);
    if (!taskId || !isPurposeId(purpose) || !categories) {
      return fail(
        reply,
        400,
        "invalid-request",
        "taskId, purpose and requestedCategories are required.",
      );
    }

    const confirmed = asBoolean(body["confirmed"]) === true;
    const containsRawMedia = asBoolean(body["containsRawMedia"]) === true;

    const service = database.serviceFor(claims.sub);
    const state = await service.getState();
    const providerConfiguration = providerConfigurationFor(runtime);

    const decision = evaluateConsent({
      state,
      provider: providerConfiguration,
      request: {
        taskId,
        purpose: purpose as PurposeId,
        providerId: runtime.providerId,
        requestedCategories: categories as DataCategory[],
        confirmed,
        containsRawMedia,
      },
      now: new Date(now()).toISOString(),
    });

    if (!decision.allowed) {
      await service.recordAttempt({
        decision,
        allowed: false,
        code: decision.code,
      });
      return fail(
        reply,
        statusForDecision(decision),
        decision.code,
        decision.message,
        decisionBody(decision),
      );
    }

    // No health data is accepted here. The token only proves that this user
    // authorised this exact task, purpose, provider and category set.
    const approval = approvals.create({
      userId: claims.sub,
      taskId,
      purpose: purpose as PurposeId,
      providerId: runtime.providerId,
      categories: categories as DataCategory[],
      confirmed,
    });

    return reply.send({
      ok: true,
      approvalToken: approval.token,
      expiresAt: approval.expiresAt,
      decision: fullDecisionBody(decision),
    });
  });

  app.post("/v1/ai/complete", async (request, reply) => {
    const claims = session(request);
    if (!hasScope(claims, "ai")) {
      return fail(reply, 403, "insufficient-scope", "This token cannot use AI features.");
    }

    const limit = aiLimiter.check(`${claims.sub}:ai-complete`);
    reply.header("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfterSeconds));
      return fail(reply, 429, "rate-limited", "Too many AI requests. Try again shortly.", {
        retryable: true,
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const runtime = config.provider;
    if (!runtime) {
      return fail(reply, 503, "no-provider", MESSAGES.noProvider);
    }

    const body = asRecord(request.body);
    if (!body) return fail(reply, 400, "invalid-request", "A JSON body is required.");

    // Unauthorized provider switching is rejected, even if the value matches.
    const declaredProvider = body["providerId"];
    if (declaredProvider !== undefined && declaredProvider !== runtime.providerId) {
      return fail(
        reply,
        400,
        "provider-not-permitted",
        "The requested provider is not the one configured on this server.",
        { retryable: false },
      );
    }

    const approvalToken = asString(body["approvalToken"]);
    const taskId = asString(body["taskId"]);
    const purpose = body["purpose"];
    const categories = asStringArray(body["requestedCategories"]);
    if (!approvalToken || !taskId || !isPurposeId(purpose) || !categories) {
      return fail(
        reply,
        400,
        "invalid-request",
        "approvalToken, taskId, purpose and requestedCategories are required.",
      );
    }

    const approval = approvals.consume(approvalToken, claims.sub);
    if (
      !approval ||
      approval.taskId !== taskId ||
      approval.purpose !== purpose ||
      approval.providerId !== runtime.providerId ||
      !sameCategories(approval.categories, categories)
    ) {
      return fail(
        reply,
        403,
        "approval-required",
        "Review the disclosure and obtain a fresh approval before sending.",
      );
    }

    const data = sanitizeSnapshot(body["data"]);
    const unrequested = findUnrequestedCategories(data, new Set(categories));
    if (unrequested.length > 0) {
      return fail(
        reply,
        422,
        "unrequested-data",
        "The request included data categories that were not approved for this task.",
        { categories: unrequested },
      );
    }

    const service = database.serviceFor(claims.sub);
    const state = await service.getState();
    const providerConfiguration = providerConfigurationFor(runtime);

    const decision = evaluateConsent({
      state,
      provider: providerConfiguration,
      request: {
        taskId,
        purpose: purpose as PurposeId,
        providerId: runtime.providerId,
        requestedCategories: categories as DataCategory[],
        confirmed: approval.confirmed,
        containsRawMedia: false,
      },
      now: new Date(now()).toISOString(),
    });

    if (!decision.allowed) {
      await service.recordAttempt({
        decision,
        allowed: false,
        code: decision.code,
      });
      return fail(
        reply,
        statusForDecision(decision),
        decision.code,
        decision.message,
        decisionBody(decision),
      );
    }

    const task = getAiTask(taskId);
    if (!task) {
      return fail(reply, 400, "unknown-task", MESSAGES.unknownTask);
    }

    let payload: AiPayload;
    try {
      payload = buildMinimalPayload(decision, data, { now: new Date(now()).toISOString() });
    } catch {
      return fail(reply, 500, "invalid-request", "The request could not be prepared.");
    }

    if (findRawCapture(payload.sections).length > 0) {
      await service.recordAttempt({
        decision,
        allowed: false,
        code: "payload-rejected",
      });
      return fail(
        reply,
        422,
        "payload-rejected",
        "Raw capture data is never forwarded to an AI provider.",
      );
    }

    let response;
    try {
      response = await invoker({
        runtime,
        task,
        purpose: decision.purpose,
        payload,
      });
    } catch {
      await service.recordAttempt({
        decision,
        allowed: false,
        code: "provider-error",
      });
      return fail(
        reply,
        502,
        "provider-error",
        "The AI provider request failed. Nothing was retried.",
        { retryable: true },
      );
    }

    await service.recordAttempt({ decision, allowed: true, code: "allowed" });

    const requestId = globalThis.crypto.randomUUID();
    return reply.send({
      ok: true,
      text: response.text,
      model: response.model ?? runtime.model,
      transmission: {
        requestId,
        at: new Date(now()).toISOString(),
        taskId,
        purpose: decision.purpose,
        providerId: runtime.providerId,
        providerLocality: runtime.locality,
        categories: decision.grantedCategories.filter(
          (category) => category !== "history.complete",
        ),
        policyVersion: decision.policyVersion,
        estimatedBytes: payload.estimatedBytes,
        historyMode: payload.historyMode,
      },
    });
  });

  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    // Never echo upstream error messages or request bodies.
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;
    if (status === 400) {
      return fail(reply, 400, "invalid-request", "The request could not be parsed.");
    }
    return fail(reply, status, "server-error", "The gateway could not complete the request.");
  });

  return app;
}
