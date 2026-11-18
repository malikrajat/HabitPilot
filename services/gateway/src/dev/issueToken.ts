/**
 * Dev-only session token issuer. In production, tokens come from your identity
 * provider; this helper exists so the hosted flow can be exercised locally.
 *
 * Usage: pnpm --filter @habitpilot/gateway token <userId> [hours] [scopes]
 */
import { issueSessionToken } from "../auth.js";

const [userId, hoursRaw, scopesRaw] = process.argv.slice(2);
const secret = process.env["HABITPILOT_SESSION_SECRET"] ?? "";

if (!userId) {
  console.error("Usage: token <userId> [hours] [scopes]");
  process.exit(1);
}
if (secret.length < 32) {
  console.error("HABITPILOT_SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

const hours = Number.parseInt(hoursRaw ?? "12", 10);
const scopes = (scopesRaw ?? "ai,consent").split(",").map((scope) => scope.trim());

const token = issueSessionToken(
  {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + (Number.isFinite(hours) ? hours : 12) * 3600,
    scopes,
  },
  secret,
);

console.log(token);
