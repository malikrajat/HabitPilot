import { buildGateway } from "./server.js";
import { loadConfigFromEnv } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfigFromEnv(process.env);
  if (!config.provider) {
    // Loud but non-fatal: consent endpoints still work, AI calls return 503.
    console.warn(
      "[gateway] No AI provider is configured. AI requests will be refused until HABITPILOT_AI_PROVIDER, HABITPILOT_AI_MODEL and a provider key are set.",
    );
  }

  const app = await buildGateway({ config, logger: false });
  await app.listen({ port: config.port, host: config.host });
  console.log(`[gateway] listening on http://${config.host}:${config.port}`);

  const shutdown = async (signal: string) => {
    console.log(`[gateway] ${signal} received, closing`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[gateway] failed to start:", error instanceof Error ? error.message : "unknown");
  process.exit(1);
});
