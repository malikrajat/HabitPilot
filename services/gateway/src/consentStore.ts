import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConsentService,
  createInitialConsentState,
  type ConsentState,
  type ConsentStateStore,
} from "@habitpilot/consent-core";

/**
 * Server-side consent records, keyed by authenticated user. This store is the
 * authority for hosted AI requests: frontend state is never trusted.
 *
 * Only consent metadata is persisted. Health payloads are never written here.
 */
export class ServerConsentDatabase {
  readonly #states = new Map<string, ConsentState>();
  readonly #file: string | undefined;
  #write: Promise<void> = Promise.resolve();

  private constructor(file?: string) {
    this.#file = file;
  }

  static async open(file?: string): Promise<ServerConsentDatabase> {
    const database = new ServerConsentDatabase(file);
    if (file) await database.#readFromDisk();
    return database;
  }

  async #readFromDisk(): Promise<void> {
    if (!this.#file) return;
    try {
      const raw = await readFile(this.#file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, ConsentState>;
      for (const [userId, state] of Object.entries(parsed)) {
        if (state && state.schemaVersion === 1) this.#states.set(userId, state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async #persist(): Promise<void> {
    if (!this.#file) return;
    const snapshot: Record<string, ConsentState> = {};
    for (const [userId, state] of this.#states) snapshot[userId] = state;
    const temporary = `${this.#file}.tmp`;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await rename(temporary, this.#file);
  }

  get(userId: string): ConsentState {
    return this.#states.get(userId) ?? createInitialConsentState();
  }

  async set(userId: string, state: ConsentState): Promise<void> {
    this.#states.set(userId, state);
    this.#write = this.#write.then(() => this.#persist());
    await this.#write;
  }

  serviceFor(userId: string, now?: () => string): ConsentService {
    const store: ConsentStateStore = {
      load: async () => this.get(userId),
      save: async (state) => this.set(userId, state),
    };
    return new ConsentService(store, now ? { now } : {});
  }
}
