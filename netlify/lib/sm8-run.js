import { readInbox, writeInbox, mergeSuggestions } from "./inbox-store.js";
import { collectSuggestions } from "./sm8-collect.js";
import { writeConfig } from "./sm8-config.js";

// Pure, so it can be tested without a blob store behind it.
export { whyNotReady } from "./sm8-rules.js";

/* One run of the ServiceM8 check, for one sync code.

   This lives in lib rather than beside the scheduled function because two things
   now call it: the quarter-hourly poller, and the "Check now" button in the app.
   Waiting up to fifteen minutes to find out whether a setup works is a miserable
   way to test it. */

const HOUR = 3600000;

export async function pollOne(code, cfg, deps) {
  const { suggestions, problems, report } = await collectSuggestions({
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

  return {
    code,
    found: suggestions.length,
    added: merged.added,
    waiting: (merged.pending || []).length,
    problems,
    report,
  };
}
