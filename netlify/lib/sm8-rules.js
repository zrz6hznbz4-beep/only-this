/* The shape of a ServiceM8 connection, and the rules for changing it.
   No dependencies, so these can be tested directly — which matters, because the
   most important rule here is that the API key only ever travels inwards. */

export const VALID_SOURCES = ["tasks", "notes", "emails"];

export function emptyConfig() {
  return {
    apiKey: null,
    staffUuid: "",
    names: [],
    sources: ["tasks"],
    lookbackHours: 48,
    enabled: false,
    lastRun: null,
    lastError: null,
    updatedAt: 0,
  };
}

// Everything the app is allowed to see. Note the absence of the key itself.
export function publicView(cfg) {
  return {
    hasKey: !!cfg.apiKey,
    staffUuid: cfg.staffUuid || "",
    names: cfg.names || [],
    sources: cfg.sources || ["tasks"],
    lookbackHours: cfg.lookbackHours || 48,
    enabled: !!cfg.enabled,
    lastRun: cfg.lastRun || null,
    lastError: cfg.lastError || null,
    ready: !!(cfg.apiKey && cfg.staffUuid && cfg.enabled),
  };
}

/* Why a check could not happen at all — as a sentence, not a code. Checked before
   reaching for ServiceM8, so pressing "Check now" with half a setup tells you which
   half is missing rather than failing somewhere out in the network. */
export function whyNotReady(cfg) {
  if (!cfg || !cfg.apiKey) return "No API key saved yet.";
  if (!cfg.staffUuid) return "Pick which staff member you are first.";
  if (!cfg.enabled) return "Offers are switched off.";
  return null;
}

export function cleanConfig(input, existing) {
  const base = Object.assign(emptyConfig(), existing || {});
  if (!input || typeof input !== "object") return base;

  // An empty string means "leave it alone"; null means "forget it".
  if (typeof input.apiKey === "string" && input.apiKey.trim()) base.apiKey = input.apiKey.trim();
  if (input.apiKey === null) base.apiKey = null;

  if (typeof input.staffUuid === "string") base.staffUuid = input.staffUuid.trim();
  if (Array.isArray(input.names)) {
    base.names = input.names.map((n) => String(n).trim()).filter(Boolean).slice(0, 10);
  } else if (typeof input.names === "string") {
    base.names = input.names.split(",").map((n) => n.trim()).filter(Boolean).slice(0, 10);
  }
  if (Array.isArray(input.sources)) {
    const picked = input.sources.filter((s) => VALID_SOURCES.includes(s));
    base.sources = picked.length ? picked : ["tasks"];
  }
  if (input.lookbackHours !== undefined) {
    const n = Number(input.lookbackHours);
    base.lookbackHours = (n >= 1 && n <= 720) ? n : 48;
  }
  if (typeof input.enabled === "boolean") base.enabled = input.enabled;

  return base;
}

