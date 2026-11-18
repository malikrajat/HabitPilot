import { randomUUID } from "node:crypto";
import type { DataCategory, PurposeId, ProviderId } from "@habitpilot/consent-core";

export interface ApprovalRecord {
  readonly token: string;
  readonly userId: string;
  readonly taskId: string;
  readonly purpose: PurposeId;
  readonly providerId: ProviderId;
  readonly categories: readonly DataCategory[];
  readonly confirmed: boolean;
  readonly expiresAtMs: number;
  used: boolean;
}

export interface ApprovalIssue {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Short-lived, single-use approvals issued after the gateway verifies consent.
 * The client cannot send health data until it holds one of these.
 */
export class ApprovalStore {
  readonly #records = new Map<string, ApprovalRecord>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxRecords: number;

  constructor(options: { now?: () => number; ttlMs?: number; maxRecords?: number } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttlMs = options.ttlMs ?? 120_000;
    this.#maxRecords = options.maxRecords ?? 5_000;
  }

  create(input: {
    userId: string;
    taskId: string;
    purpose: PurposeId;
    providerId: ProviderId;
    categories: readonly DataCategory[];
    confirmed: boolean;
  }): ApprovalIssue {
    this.#prune();
    if (this.#records.size >= this.#maxRecords) {
      const oldest = this.#records.keys().next().value;
      if (oldest) this.#records.delete(oldest);
    }
    const token = randomUUID();
    const expiresAtMs = this.#now() + this.#ttlMs;
    this.#records.set(token, {
      token,
      userId: input.userId,
      taskId: input.taskId,
      purpose: input.purpose,
      providerId: input.providerId,
      categories: [...input.categories],
      confirmed: input.confirmed,
      expiresAtMs,
      used: false,
    });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(token: string, userId: string): ApprovalRecord | null {
    this.#prune();
    const record = this.#records.get(token);
    if (!record || record.used || record.userId !== userId) return null;
    if (record.expiresAtMs <= this.#now()) {
      this.#records.delete(token);
      return null;
    }
    record.used = true;
    return record;
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, record] of this.#records) {
      if (record.expiresAtMs <= now) this.#records.delete(token);
    }
  }
}
