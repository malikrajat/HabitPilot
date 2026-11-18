import type {
  ConsentAuditEntry,
  ConsentDecision,
  ConsentState,
  ConsentStatusEntry,
  DataCategory,
  ProviderConfiguration,
  ProviderId,
  PurposeId,
} from "./types.js";
import {
  CONSENT_POLICY_VERSION,
  DATA_CATEGORIES,
  PURPOSE_IDS,
} from "./taxonomy.js";
import {
  appendAiAttemptAudit,
  applyExternalAccess,
  applySensorAccess,
  applyGrant,
  applyRevoke,
  applyRevokeAll,
  createInitialConsentState,
  getConsentStatus,
  recordPolicyVersionChange,
} from "./state.js";

/**
 * Persistence boundary. The web app backs this with IndexedDB, the desktop app
 * with local SQLite, and the gateway with its own server-side store. The
 * consent rules themselves live in this package, not in the adapter.
 */
export interface ConsentStateStore {
  load(): Promise<ConsentState>;
  save(state: ConsentState): Promise<void>;
}

export class InMemoryConsentStore implements ConsentStateStore {
  #state: ConsentState;

  constructor(state: ConsentState = createInitialConsentState()) {
    this.#state = state;
  }

  async load(): Promise<ConsentState> {
    return structuredClone(this.#state);
  }

  async save(state: ConsentState): Promise<void> {
    this.#state = structuredClone(state);
  }
}

export interface ConsentServiceOptions {
  readonly now?: () => string;
  /** Overridable only for tests; production code uses the packaged policy version. */
  readonly policyVersion?: string;
}

/**
 * Authoritative consent orchestration used by every surface. Writes are
 * serialized so two rapid toggles cannot interleave and lose a revocation.
 */
export class ConsentService {
  readonly #store: ConsentStateStore;
  readonly #now: () => string;
  readonly #policyVersion: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: ConsentStateStore, options: ConsentServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#policyVersion = options.policyVersion ?? CONSENT_POLICY_VERSION;
  }

  get policyVersion(): string {
    return this.#policyVersion;
  }

  /** Loads state, normalizing the policy version so stale grants cannot validate. */
  async getState(): Promise<ConsentState> {
    const loaded = await this.#store.load();
    const normalized: ConsentState = {
      ...createInitialConsentState(this.#policyVersion),
      ...loaded,
      schemaVersion: 1,
      policyVersion: this.#policyVersion,
      grants: loaded.grants ?? [],
      externalAccess: loaded.externalAccess ?? [],
      auditLog: loaded.auditLog ?? [],
    };
    if (loaded.policyVersion !== this.#policyVersion) {
      const upgraded = recordPolicyVersionChange(
        normalized,
        this.#now(),
        "policy",
        this.#policyVersion,
      );
      await this.#store.save(upgraded);
      return upgraded;
    }
    return normalized;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  grant(input: {
    category: DataCategory;
    providerId: ProviderId;
    purpose: PurposeId;
    providerFingerprint: string;
    actor?: string;
  }): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = applyGrant(state, {
        ...input,
        at: this.#now(),
        policyVersion: this.#policyVersion,
      });
      await this.#store.save(next);
      return next;
    });
  }

  revoke(input: {
    category: DataCategory;
    providerId: ProviderId;
    purpose?: PurposeId;
    actor?: string;
  }): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = applyRevoke(state, { ...input, at: this.#now() });
      await this.#store.save(next);
      return next;
    });
  }

  revokeAll(input: { actor?: string } = {}): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = applyRevokeAll(state, { ...input, at: this.#now() });
      await this.#store.save(next);
      return next;
    });
  }

  setExternalAccess(input: {
    providerId: ProviderId;
    enabled: boolean;
    actor?: string;
  }): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = applyExternalAccess(state, { ...input, at: this.#now() });
      await this.#store.save(next);
      return next;
    });
  }

  /** Records device-sensor grant/revoke with a timestamp. No media is referenced. */
  recordSensorAccess(input: {
    sensor: "camera" | "microphone";
    enabled: boolean;
    actor?: string;
  }): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = applySensorAccess(state, { ...input, at: this.#now() });
      await this.#store.save(next);
      return next;
    });
  }

  /** Metadata-only audit of an AI attempt. Never accepts payload content. */
  recordAttempt(input: {
    decision: ConsentDecision;
    allowed: boolean;
    code: string;
  }): Promise<ConsentState> {
    return this.#enqueue(async () => {
      const state = await this.getState();
      const next = appendAiAttemptAudit(state, {
        allowed: input.allowed,
        at: this.#now(),
        taskId: input.decision.taskId,
        providerId: input.decision.providerId,
        purpose: input.decision.purpose,
        categories: input.decision.requestedCategories,
        categoriesGranted: input.decision.grantedCategories,
        code: input.code,
      });
      await this.#store.save(next);
      return next;
    });
  }

  async statusFor(
    providerId: ProviderId,
    purpose: PurposeId,
    providerFingerprint?: string,
  ): Promise<readonly ConsentStatusEntry[]> {
    const state = await this.getState();
    return DATA_CATEGORIES.map((category) =>
      getConsentStatus(state, category, providerId, purpose, providerFingerprint),
    );
  }

  async grantedCategories(
    providerId: ProviderId,
    purpose: PurposeId,
    providerFingerprint?: string,
  ): Promise<readonly DataCategory[]> {
    const entries = await this.statusFor(providerId, purpose, providerFingerprint);
    return entries
      .filter((entry) => entry.status === "granted")
      .map((entry) => entry.category);
  }

  async auditLog(): Promise<readonly ConsentAuditEntry[]> {
    const state = await this.getState();
    return [...state.auditLog].sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Metadata-only consent export for transparency. No health records and no
   * provider credentials are included.
   */
  async exportConsentRecord(): Promise<{
    policyVersion: string;
    grants: ConsentState["grants"];
    externalAccess: ConsentState["externalAccess"];
    auditLog: readonly ConsentAuditEntry[];
  }> {
    const state = await this.getState();
    return {
      policyVersion: state.policyVersion,
      grants: state.grants,
      externalAccess: state.externalAccess,
      auditLog: state.auditLog,
    };
  }
}

export const ALL_PURPOSES: readonly PurposeId[] = PURPOSE_IDS;

export type { ProviderConfiguration };
