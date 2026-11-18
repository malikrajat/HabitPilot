import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:* https: ws://127.0.0.1:* ws://localhost:*",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "habitpilot-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
      );
    },
  };
}

// VITE_GATEWAY_URL is public configuration (a URL), never a credential.
export default defineConfig({
  plugins: [
    react(),
    cspPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.svg", "favicon-16.png", "favicon-32.png", "logo-192.png", "logo-512.png"],
      manifest: {
        name: "HabitPilot",
        short_name: "HabitPilot",
        description: "Local-first health habits with consent-gated AI.",
        theme_color: "#0b1220",
        background_color: "#0b1220",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "logo-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "logo-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallbackDenylist: [/^\/v1\//],
      },
    }),
  ],
  server: {
    port: 5173,
  },
  build: {
    sourcemap: false,
  },
});
