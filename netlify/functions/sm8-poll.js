import { readInbox, writeInbox, mergeSuggestions } from "../lib/inbox-store.js";
import { collectSuggestions } from "../lib/sm8-collect.js";
import { readConfig, writeConfig, configuredCodes } from "../lib/sm8-config.js";

/* Runs every fifteen minutes and queues up anything worth turning into a task.
   Nothing is ever created automatically — the app asks you first.

   Each sync code carries its own ServiceM8 settings, entered in the app under
   Advanced setup. The poller walks the codes that have been set up, so one
   deployment can serve several people without any of them seeing each other's work.

   Environment variables are still honoured as a fallback, for a single-user site
   that would rather keep its key out of the app entirely:

     SM8_API_KEY, SM8_SYNC_CODE, SM8_STAFF_UUID, SM8_NAMES, SM8_SOURCES, SM8_LOOKBACK_H
*/

const HOUR = 3600000;

function envFallback() {
  const env = process.env;
  if (!env.SM8_API_KEY || !env.SM8_SYNC_CODE || !env.SM8_STAFF_UUID) return null;
  return {
    code: env.SM8_SYNC_CODE.trim().toUpperCase(),
    cfg: {
      apiKey: env.SM8_API_KEY,
      staffUuid: env.SM8_STAFF_UUID.trim(),
      names: (env.SM8_NAMES || "").split(",").map((s) => s.trim()).filter(Boolean),
      sources: (env.SM8_SOURCES || "tasks").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      lookbackHours: Number(env.SM8_LOOKBACK_H) || 48,
      enabled: true,
      fromEnv: true,
    },
  };
}

export async function pollOne(code, cfg, deps) {
  const { suggestions, problems } = await collectSuggestions({
    apiKey: cfg.apiKey,
    staffUuid: cfg.staffUuid,
    names: cfg.names || [],
    sources: cfg.sources || ["tasks"],
    lookbackMs: (cfg.lookbackHours || 48) * HOUR,
  }, deps);

  const inbox = await readInbox(code);
  const merged = mergeSuggestions(inbox, suggestions);
  if (merged.added > 0) await writeInbox(code, merged);

  // Record how it went so the app can show it rather than leaving you guessing.
  if (!cfg.fromEnv) {
    await writeConfig(code, Object.assign({}, cfg, {
      lastRun: Date.now(),
      lastError: problems.length ? problems.join("; ") : null,
    }));
  }

  return { code, found: suggestions.length, added: merged.added, problems };
}

export default async () => {
  const results = [];
  const seen = new Set();

  let codes = [];
  try {
    codes = await configuredCodes();
  } catch (e) {
    codes = [];
  }

  for (const code of codes) {
    const cfg = await readConfig(code);
    if (!cfg.apiKey || !cfg.staffUuid || !cfg.enabled) continue;
    seen.add(code);
    try {
      results.push(await pollOne(code, cfg));
    } catch (e) {
      results.push({ code, error: e.message });
    }
  }

  const fallback = envFallback();
  if (fallback && !seen.has(fallback.code)) {
    try {
      results.push(await pollOne(fallback.code, fallback.cfg));
    } catch (e) {
      results.push({ code: fallback.code, error: e.message });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    lists: results.length,
    results,
  }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/15 * * * *" };
