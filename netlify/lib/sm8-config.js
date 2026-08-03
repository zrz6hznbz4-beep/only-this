import { getStore } from "@netlify/blobs";
import { emptyConfig } from "./sm8-rules.js";

/* Per-list ServiceM8 settings, stored against a sync code.

   This is what makes the integration belong to a person rather than to the
   deployment. Each sync code carries its own key and its own staff UUID, so two
   people using the same site never see each other's work — and switching the
   feature on without a key of your own does precisely nothing. */

export { emptyConfig, publicView, cleanConfig, VALID_SOURCES } from "./sm8-rules.js";

export function configStore() {
  return getStore({ name: "only-this-sm8", consistency: "strong" });
}

export async function readConfig(code) {
  if (!code) return emptyConfig();
  const data = await configStore().get(code, { type: "json" });
  return Object.assign(emptyConfig(), data || {});
}

export async function writeConfig(code, cfg) {
  await configStore().setJSON(code, Object.assign({}, cfg, { updatedAt: Date.now() }));
}

// Which lists have a setup at all — this is what the scheduled poller walks.
export async function configuredCodes() {
  const listing = await configStore().list();
  return (listing.blobs || []).map((b) => b.key);
}
