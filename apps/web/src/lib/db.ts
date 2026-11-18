import { openDB } from "idb";
import {
  createInitialConsentState,
  type ConsentState,
  type ConsentStateStore,
  type ProviderId,
  type ProviderConfiguration,
} from "@habitpilot/consent-core";
import type { LocalHealthData } from "./types.js";
import { desktopRead, desktopWrite, isDesktopRuntime } from "./desktop.js";

export interface SensorPreferences {
  cameraOptIn?: boolean;
  microphoneOptIn?: boolean;
  speakReplies?: boolean;
}

export interface AppSettings {
  activeProviderId?: ProviderId;
  /** Public URL only. Credentials are never stored here. */
  gatewayUrl?: string;
  seeded?: boolean;
  /** Desktop first-run setup completed or skipped. */
  setupComplete?: boolean;
  sensors?: SensorPreferences;
}

type StorageKey = "settings" | "providers" | "consent" | "consentMirror" | "localHealth";

const STORE_BY_KEY: Record<StorageKey, string> = {
  settings: "settings",
  providers: "providers",
  consent: "consent",
  consentMirror: "consentMirror",
  localHealth: "localHealth",
};

export interface ConsentMirror {
  readonly state: ConsentState;
  readonly syncedAt: string;
}

const DATABASE_NAME = "habitpilot";
const DATABASE_VERSION = 3;
const VALUE_KEY = "value";

let databasePromise: ReturnType<typeof openDB> | null = null;

function getDatabase() {
  if (!databasePromise) {
    databasePromise = openDB(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        for (const store of Object.values(STORE_BY_KEY)) {
          if (!database.objectStoreNames.contains(store)) database.createObjectStore(store);
        }
      },
    });
  }
  return databasePromise;
}

async function readState<T>(key: StorageKey): Promise<T | null> {
  if (isDesktopRuntime()) {
    return desktopRead<T>(key);
  }
  const database = await getDatabase();
  return ((await database.get(STORE_BY_KEY[key], VALUE_KEY)) as T | undefined) ?? null;
}

async function writeState<T>(key: StorageKey, value: T): Promise<void> {
  if (isDesktopRuntime()) {
    await desktopWrite(key, value);
    return;
  }
  const database = await getDatabase();
  await database.put(STORE_BY_KEY[key], value, VALUE_KEY);
}

/**
 * Consent persistence. IndexedDB in the browser/PWA, local SQLite (via the
 * Tauri bridge) in the desktop app. Both feed the same ConsentService rules.
 */
export class LocalConsentStore implements ConsentStateStore {
  async load(): Promise<ConsentState> {
    return (await readState<ConsentState>("consent")) ?? createInitialConsentState();
  }

  async save(state: ConsentState): Promise<void> {
    await writeState("consent", state);
  }
}

/** @deprecated name kept for compatibility; storage is selected at runtime. */
export class IndexedDbConsentStore extends LocalConsentStore {}

export async function saveConsentMirror(state: ConsentState): Promise<string> {
  const syncedAt = new Date().toISOString();
  await writeState<ConsentMirror>("consentMirror", { state, syncedAt });
  return syncedAt;
}

export async function loadConsentMirror(): Promise<ConsentMirror | null> {
  return readState<ConsentMirror>("consentMirror");
}

export async function loadSettings(): Promise<AppSettings> {
  return (await readState<AppSettings>("settings")) ?? {};
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeState("settings", settings);
}

export async function loadProviders(): Promise<ProviderConfiguration[]> {
  return (await readState<ProviderConfiguration[]>("providers")) ?? [];
}

export async function saveProvider(provider: ProviderConfiguration): Promise<void> {
  const providers = await loadProviders();
  const next = [
    ...providers.filter((entry) => entry.providerId !== provider.providerId),
    provider,
  ];
  await writeState("providers", next);
}

export async function removeProvider(providerId: ProviderId): Promise<void> {
  const providers = await loadProviders();
  await writeState(
    "providers",
    providers.filter((entry) => entry.providerId !== providerId),
  );
}

export async function loadLocalHealth(): Promise<LocalHealthData | null> {
  return readState<LocalHealthData>("localHealth");
}

export async function saveLocalHealth(data: LocalHealthData): Promise<void> {
  await writeState("localHealth", data);
}
