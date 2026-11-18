export type Page = "setup" | "dashboard" | "assistant" | "sensors" | "privacy" | "audit";

export const PAGE_TITLES: Record<Page, string> = {
  setup: "Desktop setup",
  dashboard: "Dashboard",
  assistant: "AI Assistant",
  sensors: "Sensors & observations",
  privacy: "Privacy & AI Settings",
  audit: "Consent audit log",
};

export function isPage(value: string): value is Page {
  return (
    value === "setup" ||
    value === "dashboard" ||
    value === "assistant" ||
    value === "sensors" ||
    value === "privacy" ||
    value === "audit"
  );
}
