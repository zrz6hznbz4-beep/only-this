import {
  sm8Get, taskSuggestion, noteSuggestion, emailSuggestion,
  tasksForStaff, notesMentioning, inboundEmails, recentOnly,
} from "./servicem8.js";

/* Deciding what is worth offering. Kept apart from the function that runs it so it
   can be tested against a stand-in ServiceM8 rather than the real one. */

// Jobs are looked up once and reused, so a batch of notes on one job is a single call.
function jobLookup(apiKey) {
  const cache = new Map();
  return async function (uuid) {
    if (!uuid) return null;
    if (cache.has(uuid)) return cache.get(uuid);
    let job = null;
    try {
      job = await sm8Get(`job/${uuid}.json`, apiKey);
    } catch (e) {
      job = null; // a job we cannot read should not sink the whole run
    }
    cache.set(uuid, job);
    return job;
  };
}

export async function collectSuggestions(cfg, deps) {
  const getJob = (deps && deps.getJob) || jobLookup(cfg.apiKey);
  const get = (deps && deps.get) || ((path) => sm8Get(path, cfg.apiKey));
  const now = (deps && deps.now) || Date.now();
  const out = [];
  const problems = [];

  if (cfg.sources.includes("tasks")) {
    try {
      const tasks = await get("task.json");
      for (const t of tasksForStaff(tasks, cfg.staffUuid)) {
        const s = taskSuggestion(t, await getJob(t.job_uuid || t.related_object_uuid));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("tasks: " + e.message); }
  }

  if (cfg.sources.includes("notes")) {
    try {
      const notes = await get("note.json");
      for (const n of notesMentioning(notes, cfg.names)) {
        const s = noteSuggestion(n, await getJob(n.related_object_uuid || n.job_uuid));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("notes: " + e.message); }
  }

  if (cfg.sources.includes("emails")) {
    try {
      const messages = await get("emailmessage.json");
      for (const m of inboundEmails(messages)) {
        const s = emailSuggestion(m, await getJob(m.related_object_uuid || m.job_uuid));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("emails: " + e.message); }
  }

  return { suggestions: recentOnly(out, cfg.lookbackMs, now), problems };
}

