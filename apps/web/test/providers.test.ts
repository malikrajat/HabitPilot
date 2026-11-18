import { describe, expect, it } from "vitest";
import type { ProviderConfiguration } from "@habitpilot/consent-core";
import { assessEndpoint, selectActiveProvider } from "../src/lib/providerSelection.js";

function provider(overrides: Partial<ProviderConfiguration> = {}): ProviderConfiguration {
  return {
    providerId: "ollama",
    model: "llama3.2",
    locality: "device",
    configuredAt: "2026-11-18T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

describe("endpoint classification", () => {
  it("treats loopback as device-local", () => {
    expect(assessEndpoint("http://127.0.0.1:11434")?.locality).toBe("device");
    expect(assessEndpoint("http://localhost:1234")?.locality).toBe("device");
    expect(assessEndpoint("http://[::1]:11434")?.locality).toBe("device");
  });

  it("treats private networks as local-network", () => {
    expect(assessEndpoint("http://192.168.1.50:11434")?.locality).toBe("local-network");
    expect(assessEndpoint("http://10.0.0.5:8000/v1")?.locality).toBe("local-network");
    expect(assessEndpoint("http://172.20.1.2:8000")?.locality).toBe("local-network");
    expect(assessEndpoint("http://gpu-box.local:8000")?.locality).toBe("local-network");
  });

  it("treats public hosts as remote", () => {
    expect(assessEndpoint("https://api.openai.com/v1")?.locality).toBe("remote");
    expect(assessEndpoint("https://example.com:8443/v1")?.locality).toBe("remote");
  });

  it("rejects non-http(s) and malformed endpoints", () => {
    expect(assessEndpoint("ftp://example.com")).toBeNull();
    expect(assessEndpoint("not a url")).toBeNull();
    expect(assessEndpoint("file:///etc/passwd")).toBeNull();
  });
});

describe("active provider selection", () => {
  const ollama = provider();
  const lmstudio = provider({ providerId: "lmstudio", model: "local-model" });

  it("returns the exact preferred provider", () => {
    expect(selectActiveProvider([ollama, lmstudio], "lmstudio")?.providerId).toBe("lmstudio");
  });

  it("never falls back when the preferred provider is missing", () => {
    expect(selectActiveProvider([ollama, lmstudio], "openai")).toBeNull();
  });

  it("auto-selects only when no preference exists", () => {
    expect(selectActiveProvider([ollama, lmstudio])?.providerId).toBe("ollama");
    expect(selectActiveProvider([])).toBeNull();
  });
});
