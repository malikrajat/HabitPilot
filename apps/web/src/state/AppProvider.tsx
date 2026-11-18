import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AiRequestPipeline,
  ConsentService,
  MESSAGES,
  buildMinimalPayload,
  createInitialConsentState,
  describePayload,
  evaluateConsent,
  getCategoryDefinition,
  getProviderDefinition,
  providerFingerprint,
  type AiPayload,
  type AiRequestInput,
  type ConsentAuditEntry,
  type ConsentDecision,
  type ConsentState,
  type DataCategory,
  type ObservationRecord,
  type ProviderConfiguration,
  type ProviderId,
  type PurposeId,
  type TransmissionRecord,
} from "@habitpilot/consent-core";
import {
  LocalConsentStore,
  loadConsentMirror,
  loadLocalHealth,
  loadProviders,
  loadSettings,
  removeProvider as removeProviderFromDb,
  saveConsentMirror,
  saveLocalHealth,
  saveProvider as saveProviderToDb,
  saveSettings,
  type AppSettings,
  type ConsentMirror,
  type SensorPreferences,
} from "../lib/db.js";
import { createSampleHealthData } from "../lib/sampleData.js";
import { selectSnapshotForCategories } from "../lib/dataSelection.js";
import { LocalHttpTransport, defaultEndpointFor } from "../lib/localTransport.js";
import {
  DesktopHttpTransport,
  desktopAiReady,
  desktopCredentialBackend,
  desktopDeleteSecret,
  desktopSecretStatus,
  desktopSetSecret,
  defaultRemoteEndpoint,
  isDesktopRuntime,
} from "../lib/desktop.js";
import { GatewayClient, GatewayError, type GatewayProviderInfo } from "../lib/gatewayClient.js";
import { assessEndpoint, selectActiveProvider } from "../lib/providerSelection.js";
import type { LocalHealthData } from "../lib/types.js";

export interface AiOutcomeError {
  readonly code: string;
  readonly message: string;
  readonly missingCategories: readonly DataCategory[];
  readonly outdatedCategories: readonly DataCategory[];
  readonly disclosures: readonly string[];
  readonly retryable: boolean;
}

export interface AiOutcome {
  readonly ok: boolean;
  readonly text?: string;
  readonly model?: string;
  readonly transmission?: TransmissionRecord;
  readonly error?: AiOutcomeError;
}

export interface AiPreviewOutcome {
  readonly decision: ConsentDecision;
  readonly payload: AiPayload | null;
  readonly categories: readonly DataCategory[];
  readonly recordCount: number;
  readonly estimatedBytes: number;
  /** Hosted mode only: single-use token issued by the gateway. */
  readonly approvalToken?: string;
  readonly approvalExpiresAt?: string;
}

export type ObservationCategory =
  | "observations.eating"
  | "observations.posture_eye_screen"
  | "observations.breathing";

export interface ProviderSetupInput {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly endpoint: string;
}

interface AppContextValue {
  readonly ready: boolean;
  readonly loadError: string | null;
  readonly desktop: boolean;
  readonly credentialBackendName: string | null;
  readonly setupComplete: boolean;
  readonly sensorPreferences: Required<SensorPreferences>;
  readonly speakReplies: boolean;
  completeSetup(): Promise<void>;
  restartSetup(): Promise<void>;
  setSensorPreference(key: keyof SensorPreferences, value: boolean): Promise<void>;
  recordSensorAudit(sensor: "camera" | "microphone", enabled: boolean): Promise<void>;
  addObservation(category: ObservationCategory, record: ObservationRecord): Promise<void>;
  readonly health: LocalHealthData | null;
  readonly providers: readonly ProviderConfiguration[];
  readonly activeProvider: ProviderConfiguration | null;
  readonly consentState: ConsentState;
  readonly activeProviderFingerprint: string | null;
  readonly hosted: boolean;
  readonly gatewayUrl: string;
  readonly gatewayConnected: boolean;
  readonly gatewayInfo: GatewayProviderInfo | null;
  readonly gatewayError: string | null;
  readonly consentMirrorSyncedAt: string | null;
  readonly consentMirror: ConsentMirror | null;
  readonly localAuditLog: readonly ConsentAuditEntry[];
  readonly working: boolean;
  grantConsent(category: DataCategory, purpose: PurposeId): Promise<void>;
  revokeConsent(category: DataCategory, purpose: PurposeId): Promise<void>;
  revokeAllConsent(): Promise<void>;
  setExternalAccess(enabled: boolean): Promise<void>;
  addProvider(input: ProviderSetupInput, options?: { remote?: boolean }): Promise<void>;
  removeProvider(providerId: ProviderId): Promise<void>;
  setActiveProvider(providerId: ProviderId): Promise<void>;
  connectGateway(url: string, token: string): Promise<void>;
  refreshGateway(token?: string): Promise<void>;
  disconnectGateway(): Promise<void>;
  secretStatus(providerId: ProviderId): Promise<boolean>;
  storeSecret(providerId: ProviderId, secret: string): Promise<void>;
  deleteSecret(providerId: ProviderId): Promise<void>;
  previewAi(input: AiRequestInput): Promise<AiPreviewOutcome>;
  sendAi(input: AiRequestInput): Promise<AiOutcome>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

function outcomeError(
  code: string,
  message: string,
  extras: Partial<Omit<AiOutcomeError, "code" | "message">> = {},
): AiOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      missingCategories: extras.missingCategories ?? [],
      outdatedCategories: extras.outdatedCategories ?? [],
      disclosures: extras.disclosures ?? [],
      retryable: extras.retryable ?? false,
    },
  };
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const desktop = isDesktopRuntime();
  const consentService = useRef<ConsentService>(new ConsentService(new LocalConsentStore()));
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [health, setHealth] = useState<LocalHealthData | null>(null);
  const [providers, setProviders] = useState<ProviderConfiguration[]>([]);
  const [settings, setSettings] = useState<AppSettings>({});
  const [localConsent, setLocalConsent] = useState<ConsentState>(createInitialConsentState());
  const [serverConsent, setServerConsent] = useState<ConsentState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [gatewayInfo, setGatewayInfo] = useState<GatewayProviderInfo | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [consentMirror, setConsentMirror] = useState<ConsentMirror | null>(null);
  const [working, setWorking] = useState(false);
  const [credentialBackendName, setCredentialBackendName] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    void desktopCredentialBackend()
      .then(setCredentialBackendName)
      .catch(() => setCredentialBackendName(null));
  }, [desktop]);

  const transportFor = useCallback(
    (provider: ProviderConfiguration) =>
      desktop ? new DesktopHttpTransport(provider) : new LocalHttpTransport(provider),
    [desktop],
  );

  const providersRef = useRef<ProviderConfiguration[]>([]);
  providersRef.current = providers;
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const gatewayUrlRef = useRef<string>("");
  gatewayUrlRef.current = settings.gatewayUrl ?? "";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loadedSettings = await loadSettings();
        let loadedHealth = await loadLocalHealth();
        if (!loadedHealth) {
          loadedHealth = createSampleHealthData();
          await saveLocalHealth(loadedHealth);
        }
        const loadedProviders = await loadProviders();
        const consent = await consentService.current.getState();
        const mirror = await loadConsentMirror();
        if (cancelled) return;
        setSettings(loadedSettings);
        setHealth(loadedHealth);
        setProviders(loadedProviders);
        setLocalConsent(consent);
        setConsentMirror(mirror);
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "HabitPilot could not open its local database.",
          );
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProvider = useMemo(
    () => selectActiveProvider(providers, settings.activeProviderId),
    [providers, settings.activeProviderId],
  );

  const gatewayConnected = Boolean(
    activeProvider &&
      activeProvider.locality !== "device" &&
      gatewayInfo?.providerId === activeProvider.providerId &&
      token &&
      settings.gatewayUrl,
  );
  // Any non-device provider reached through the gateway is server-enforced.
  // On desktop, a non-device provider may instead use an OS-stored credential
  // directly; the browser has no such path.
  const hosted = Boolean(
    activeProvider &&
      activeProvider.locality !== "device" &&
      (desktop ? gatewayConnected : true),
  );
  const activeProviderFingerprint = activeProvider
    ? hosted && gatewayInfo?.providerFingerprint
      ? gatewayInfo.providerFingerprint
      : providerFingerprint(activeProvider)
    : null;
  const consentState = hosted ? serverConsent ?? createInitialConsentState() : localConsent;

  const persistSettings = useCallback(async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
  }, []);

  const gatewayClient = useCallback((): GatewayClient | null => {
    const url = gatewayUrlRef.current;
    const currentToken = tokenRef.current;
    if (!url || !currentToken) return null;
    return new GatewayClient(url, currentToken);
  }, []);

  const refreshGateway = useCallback(
    async (overrideToken?: string) => {
      const url = gatewayUrlRef.current;
      const currentToken = overrideToken ?? tokenRef.current;
      if (!url || !currentToken) return;
      const client = new GatewayClient(url, currentToken);
      const info = await client.providerInfo();
      const state = await client.consentState();
      const syncedAt = await saveConsentMirror(state);
      setGatewayInfo(info);
      setServerConsent(state);
      setConsentMirror({ state, syncedAt });
      setGatewayError(null);
      if (overrideToken) setToken(overrideToken);
    },
    [],
  );

  const connectGateway = useCallback(
    async (url: string, nextToken: string) => {
      const normalized = url.trim().replace(/\/$/, "");
      if (!/^https?:\/\//i.test(normalized)) {
        throw new Error("Enter the gateway URL including http:// or https://.");
      }
      if (!nextToken.trim()) throw new Error("A gateway session token is required.");
      const client = new GatewayClient(normalized, nextToken.trim());
      const info = await client.providerInfo();
      if (!info.configured || !info.providerId) {
        throw new Error(MESSAGES.noProvider);
      }
      const state = await client.consentState();
      const syncedAt = await saveConsentMirror(state);
      setConsentMirror({ state, syncedAt });

      const configuration: ProviderConfiguration = {
        providerId: info.providerId,
        model: info.model ?? "server-managed",
        locality: info.locality ?? "remote",
        endpoint: normalized,
        configuredAt: new Date().toISOString(),
        status: "active",
      };
      await saveProviderToDb(configuration);
      const nextProviders = [
        ...providersRef.current.filter(
          (provider) => provider.providerId !== configuration.providerId,
        ),
        configuration,
      ];
      setProviders(nextProviders);
      await persistSettings({
        ...settings,
        gatewayUrl: normalized,
        activeProviderId: configuration.providerId,
      });
      setToken(nextToken.trim());
      setGatewayInfo(info);
      setServerConsent(state);
      setGatewayError(null);
    },
    [persistSettings, settings],
  );

  const refreshGatewaySafe = useCallback(
    async (overrideToken?: string) => {
      setWorking(true);
      try {
        await refreshGateway(overrideToken);
      } catch (error) {
        setGatewayError(
          error instanceof GatewayError
            ? error.message
            : "The gateway could not be verified. Check the URL and token.",
        );
        throw error;
      } finally {
        setWorking(false);
      }
    },
    [refreshGateway],
  );

  const disconnectGateway = useCallback(async () => {
    const previous = gatewayInfo?.providerId ?? activeProvider?.providerId;
    if (previous) {
      await removeProviderFromDb(previous);
      setProviders((current) => current.filter((p) => p.providerId !== previous));
    }
    const nextSettings: AppSettings = { ...settings };
    delete nextSettings.gatewayUrl;
    delete nextSettings.activeProviderId;
    await persistSettings(nextSettings);
    setToken(null);
    setGatewayInfo(null);
    setServerConsent(null);
    setGatewayError(null);
  }, [activeProvider?.providerId, gatewayInfo?.providerId, persistSettings, settings]);

  const grantConsent = useCallback(
    async (category: DataCategory, purpose: PurposeId) => {
      setWorking(true);
      try {
        if (hosted) {
          const client = gatewayClient();
          if (!client) throw new Error("Connect the secure gateway before changing consent.");
          await client.grant(category, purpose);
          await refreshGateway();
        } else {
          if (!activeProvider) throw new Error(MESSAGES.noProvider);
          const state = await consentService.current.grant({
            category,
            purpose,
            providerId: activeProvider.providerId,
            providerFingerprint: providerFingerprint(activeProvider),
          });
          setLocalConsent(state);
        }
      } finally {
        setWorking(false);
      }
    },
    [activeProvider?.providerId, gatewayClient, hosted, refreshGateway],
  );

  const revokeConsent = useCallback(
    async (category: DataCategory, purpose: PurposeId) => {
      setWorking(true);
      try {
        if (hosted) {
          const client = gatewayClient();
          if (!client) throw new Error("Connect the secure gateway before changing consent.");
          await client.revoke(category, purpose);
          await refreshGateway();
        } else {
          const state = await consentService.current.revoke({
            category,
            purpose,
            providerId: activeProvider?.providerId ?? "ollama",
          });
          setLocalConsent(state);
        }
      } finally {
        setWorking(false);
      }
    },
    [activeProvider?.providerId, gatewayClient, hosted, refreshGateway],
  );

  const revokeAllConsent = useCallback(async () => {
    setWorking(true);
    try {
      if (hosted) {
        const client = gatewayClient();
        if (!client) throw new Error("Connect the secure gateway before changing consent.");
        await client.revokeAll();
        await refreshGateway();
      } else {
        setLocalConsent(await consentService.current.revokeAll());
      }
    } finally {
      setWorking(false);
    }
  }, [gatewayClient, hosted, refreshGateway]);

  const setExternalAccess = useCallback(
    async (enabled: boolean) => {
      if (!activeProvider) throw new Error(MESSAGES.noProvider);
      setWorking(true);
      try {
        if (hosted) {
          const client = gatewayClient();
          if (!client) throw new Error("Connect the secure gateway before changing access.");
          await client.setExternalAccess(enabled);
          await refreshGateway();
        } else {
          const state = await consentService.current.setExternalAccess({
            providerId: activeProvider.providerId,
            enabled,
          });
          setLocalConsent(state);
        }
      } finally {
        setWorking(false);
      }
    },
    [activeProvider, gatewayClient, hosted, refreshGateway],
  );

  const addProvider = useCallback(
    async (input: ProviderSetupInput, options?: { remote?: boolean }) => {
      const definition = getProviderDefinition(input.providerId);
      if (!definition.deviceCallable && !(desktop && options?.remote)) {
        throw new Error(
          "Remote providers must be used through the secure gateway. Connect the gateway instead.",
        );
      }
      if (!input.model.trim()) throw new Error("Choose a model name.");
      const endpoint =
        input.endpoint.trim() ||
        (definition.deviceCallable
          ? defaultEndpointFor(input.providerId)
          : defaultRemoteEndpoint(input.providerId));
      if ((definition.id === "openai-compatible" || !definition.deviceCallable) && !endpoint) {
        throw new Error("Enter the endpoint URL of your provider.");
      }

      let locality: ProviderConfiguration["locality"] = definition.defaultLocality;
      if (endpoint) {
        const assessment = assessEndpoint(endpoint);
        if (!assessment) {
          throw new Error("Enter a valid http:// or https:// endpoint.");
        }
        if (definition.deviceCallable) {
          if (!desktop && assessment.locality === "remote") {
            throw new Error(
              "Remote endpoints must be used through the secure gateway. Connect the gateway instead, or enter a loopback/private-network endpoint.",
            );
          }
          locality = assessment.locality;
        } else {
          locality = "remote";
        }
      }

      const configuration: ProviderConfiguration = {
        providerId: input.providerId,
        model: input.model.trim(),
        locality,
        ...(endpoint ? { endpoint } : {}),
        configuredAt: new Date().toISOString(),
        status: "active",
      };
      await saveProviderToDb(configuration);
      const nextProviders = [
        ...providersRef.current.filter(
          (provider) => provider.providerId !== configuration.providerId,
        ),
        configuration,
      ];
      setProviders(nextProviders);
      if (!settings.activeProviderId) {
        await persistSettings({ ...settings, activeProviderId: configuration.providerId });
      }
    },
    [desktop, persistSettings, settings],
  );

  const removeProvider = useCallback(
    async (providerId: ProviderId) => {
      await removeProviderFromDb(providerId);
      const nextProviders = providersRef.current.filter(
        (provider) => provider.providerId !== providerId,
      );
      setProviders(nextProviders);
      if (settings.activeProviderId === providerId) {
        const nextActive = nextProviders[0]?.providerId;
        const nextSettings: AppSettings = { ...settings };
        if (nextActive) nextSettings.activeProviderId = nextActive;
        else delete nextSettings.activeProviderId;
        if (!nextActive) delete nextSettings.gatewayUrl;
        await persistSettings(nextSettings);
        if (!nextActive) {
          setToken(null);
          setGatewayInfo(null);
          setServerConsent(null);
        }
      }
    },
    [persistSettings, settings],
  );

  const setActiveProvider = useCallback(
    async (providerId: ProviderId) => {
      await persistSettings({ ...settings, activeProviderId: providerId });
      const provider = providersRef.current.find((item) => item.providerId === providerId);
      if (provider && provider.locality === "remote" && token) {
        try {
          await refreshGateway();
        } catch {
          // The error is surfaced through gatewayError.
        }
      }
    },
    [persistSettings, refreshGateway, settings, token],
  );

  const sensorPreferences: Required<SensorPreferences> = {
    cameraOptIn: settings.sensors?.cameraOptIn === true,
    microphoneOptIn: settings.sensors?.microphoneOptIn === true,
    speakReplies: settings.sensors?.speakReplies === true,
  };

  const setSensorPreference = useCallback(
    async (key: keyof SensorPreferences, value: boolean) => {
      await persistSettings({
        ...settings,
        sensors: { ...settings.sensors, [key]: value },
      });
    },
    [persistSettings, settings],
  );

  const recordSensorAudit = useCallback(
    async (sensor: "camera" | "microphone", enabled: boolean) => {
      const state = await consentService.current.recordSensorAccess({ sensor, enabled });
      setLocalConsent(state);
    },
    [],
  );

  const addObservation = useCallback(
    async (category: ObservationCategory, record: ObservationRecord) => {
      if (!health) throw new Error("Local health data is not loaded.");
      const key =
        category === "observations.eating"
          ? "eating"
          : category === "observations.breathing"
            ? "breathing"
            : "postureEyeScreen";
      const observations = health.snapshot.observations ?? {};
      const existing = observations[key] ?? [];
      const nextHealth: LocalHealthData = {
        ...health,
        snapshot: {
          ...health.snapshot,
          observations: {
            ...observations,
            [key]: [record, ...existing].slice(0, 100),
          },
        },
      };
      await saveLocalHealth(nextHealth);
      setHealth(nextHealth);
    },
    [health],
  );

  const completeSetup = useCallback(async () => {
    await persistSettings({ ...settings, setupComplete: true });
  }, [persistSettings, settings]);

  const restartSetup = useCallback(async () => {
    await persistSettings({ ...settings, setupComplete: false });
  }, [persistSettings, settings]);

  const previewAi = useCallback(
    async (input: AiRequestInput): Promise<AiPreviewOutcome> => {
      if (!activeProvider) {
        const decision = evaluateConsent({
          state: consentState,
          provider: null,
          request: {
            taskId: input.taskId,
            purpose: input.purpose,
            providerId: input.providerId,
            requestedCategories: input.requestedCategories,
            confirmed: input.confirmed,
          },
        });
        return {
          decision,
          payload: null,
          categories: [],
          recordCount: 0,
          estimatedBytes: 0,
        };
      }

      if (hosted) {
        const client = gatewayClient();
        if (!client) {
          throw new Error(
            "The secure AI gateway is not connected. Reconnect it in Privacy & AI Settings before reviewing a disclosure.",
          );
        }
        try {
          const authorization = await client.authorize({
            taskId: input.taskId,
            purpose: input.purpose,
            categories: input.requestedCategories,
            confirmed: input.confirmed === true,
            containsRawMedia: input.containsRawMedia === true,
          });
          const decision = authorization.decision;
          if (!decision.allowed) {
            return {
              decision,
              payload: null,
              categories: [],
              recordCount: 0,
              estimatedBytes: 0,
            };
          }
          const payload = buildMinimalPayload(decision, input.data);
          const description = describePayload(payload);
          return {
            decision,
            payload,
            categories: description.categories,
            recordCount: description.recordCount,
            estimatedBytes: description.estimatedBytes,
            approvalToken: authorization.approvalToken,
            approvalExpiresAt: authorization.expiresAt,
          };
        } catch (error) {
          if (error instanceof GatewayError) {
            const decision: ConsentDecision = {
              allowed: false,
              code: error.code as ConsentDecision["code"],
              message: error.message,
              taskId: input.taskId,
              purpose: input.purpose,
              providerId: activeProvider.providerId,
              providerLocality: activeProvider.locality,
              policyVersion: consentState.policyVersion,
              requestedCategories: input.requestedCategories,
              grantedCategories: [],
              missingCategories: error.missingCategories,
              outdatedCategories: error.outdatedCategories,
              changedCategories: error.changedCategories,
              disclosures: error.disclosures,
              requiresConfirmation: error.code === "confirmation-required",
              confirmed: input.confirmed === true,
              historyMode: input.requestedCategories.includes("history.complete")
                ? "complete"
                : "recent",
              evaluatedAt: new Date().toISOString(),
            };
            return {
              decision,
              payload: null,
              categories: [],
              recordCount: 0,
              estimatedBytes: 0,
            };
          }
          throw error;
        }
      }

      const pipeline = new AiRequestPipeline({
        consent: consentService.current,
        providers: () => providersRef.current,
        transport: transportFor(activeProvider),
      });
      const preview = await pipeline.preview(input);
      return {
        decision: preview.decision,
        payload: preview.payload,
        categories: preview.description?.categories ?? [],
        recordCount: preview.description?.recordCount ?? 0,
        estimatedBytes: preview.description?.estimatedBytes ?? 0,
      };
    },
    [activeProvider, consentState, gatewayClient, hosted, transportFor],
  );

  const sendAi = useCallback(
    async (input: AiRequestInput): Promise<AiOutcome> => {
      if (!activeProvider) {
        return outcomeError("no-provider", MESSAGES.noProvider);
      }

      if (hosted) {
        const client = gatewayClient();
        if (!client) {
          return outcomeError(
            "gateway-unavailable",
            "The secure AI gateway is not connected. Reconnect it in Privacy & AI Settings before using a remote provider.",
          );
        }        const data = selectSnapshotForCategories(input.data, input.requestedCategories);
        setWorking(true);
        try {
          if (!input.approvalToken) {
            return outcomeError(
              "approval-required",
              "Review the disclosure and obtain a fresh approval before sending.",
            );
          }
          const result = await client.complete({
            approvalToken: input.approvalToken,
            taskId: input.taskId,
            purpose: input.purpose,
            categories: input.requestedCategories,
            data,
          });
          return {
            ok: true,
            text: result.text,
            ...(result.model ? { model: result.model } : {}),
            transmission: result.transmission,
          };
        } catch (error) {
          if (error instanceof GatewayError) {
            return outcomeError(error.code, error.message, {
              missingCategories: error.missingCategories,
              outdatedCategories: error.outdatedCategories,
              disclosures: error.disclosures,
              retryable: error.retryable,
            });
          }
          return outcomeError(
            "network-error",
            "The gateway request failed. Nothing was retried automatically.",
            { retryable: true },
          );
        } finally {
          setWorking(false);
        }
      }

      if (!hosted && desktop && activeProvider.endpoint) {
        // A provider configured through the gateway cannot be called directly
        // after the gateway connection is lost.
        if (settings.gatewayUrl && activeProvider.endpoint === settings.gatewayUrl) {
          return outcomeError(
            "gateway-unavailable",
            "This provider was configured through the gateway. Reconnect the gateway in Privacy & AI Settings, or add a direct desktop provider endpoint.",
          );
        }
      }

      if (desktop && activeProvider.locality === "remote") {
        const ready = await desktopAiReady(activeProvider.providerId).catch(() => false);
        if (!ready) {
          return outcomeError(
            "credential-missing",
            "No credential is stored for this provider. Add one in Privacy & AI Settings; the desktop app keeps it in the OS secret store.",
          );
        }
      }

      const pipeline = new AiRequestPipeline({
        consent: consentService.current,
        providers: () => providersRef.current,
        transport: transportFor(activeProvider),
      });
      setWorking(true);
      try {
        const result = await pipeline.complete(input);
        const state = await consentService.current.getState();
        setLocalConsent(state);
        if (result.ok) {
          return {
            ok: true,
            text: result.text,
            ...(result.model ? { model: result.model } : {}),
            transmission: result.transmission,
          };
        }
        return outcomeError(result.error.code, result.error.message, {
          missingCategories: result.error.missingCategories ?? [],
          outdatedCategories: result.error.outdatedCategories ?? [],
          disclosures: result.error.disclosures ?? [],
          retryable: result.error.retryable ?? false,
        });
      } finally {
        setWorking(false);
      }
    },
    [activeProvider, desktop, gatewayClient, hosted, settings.gatewayUrl, transportFor],
  );

  const secretStatus = useCallback(
    async (providerId: ProviderId) =>
      desktop ? desktopSecretStatus(providerId).catch(() => false) : false,
    [desktop],
  );

  const storeSecret = useCallback(
    async (providerId: ProviderId, secret: string) => {
      if (!desktop) throw new Error("OS secret storage is only available in the desktop app.");
      await desktopSetSecret(providerId, secret);
    },
    [desktop],
  );

  const deleteSecret = useCallback(
    async (providerId: ProviderId) => {
      if (!desktop) return;
      await desktopDeleteSecret(providerId);
    },
    [desktop],
  );

  const value: AppContextValue = {
    ready,
    loadError,
    desktop,
    credentialBackendName,
    setupComplete: settings.setupComplete === true,
    sensorPreferences,
    speakReplies: sensorPreferences.speakReplies,
    completeSetup,
    restartSetup,
    setSensorPreference,
    recordSensorAudit,
    addObservation,
    health,
    providers,
    activeProvider,
    consentState,
    activeProviderFingerprint,
    hosted,
    gatewayUrl: settings.gatewayUrl ?? "",
    gatewayConnected,
    gatewayInfo,
    gatewayError,
    consentMirrorSyncedAt: consentMirror?.syncedAt ?? null,
    consentMirror,
    localAuditLog: localConsent.auditLog,
    working,
    grantConsent,
    revokeConsent,
    revokeAllConsent,
    setExternalAccess,
    addProvider,
    removeProvider,
    setActiveProvider,
    connectGateway,
    refreshGateway: refreshGatewaySafe,
    disconnectGateway,
    secretStatus,
    storeSecret,
    deleteSecret,
    previewAi,
    sendAi,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useCategoryLabel(category: DataCategory): string {
  return getCategoryDefinition(category).label;
}
