import {
  sm8Get, sm8ListOrAll, taskSuggestion, noteSuggestion, emailSuggestion,
  tasksForStaff, notesMentioning, inboundEmails, recentOnly,
  jobUuidFor, isTaskDone, taskOwner, sm8Time, tidy,
  myOpenTasksFilter, openTasksFilter,
} from "./servicem8.js";

/* Deciding what is worth offering.

   The important thing here is what is *not* fetched. ServiceM8 caps a response at a
   thousand records and pages the rest behind a cursor, so asking for a whole resource
   and sorting it out afterwards gets you an arbitrary slice — on a real account, years
   of finished work and none of today's. Each source is therefore narrowed at the
   server with $filter, and paged to the end.

   Alongside the suggestions it keeps a tally of what it saw and where things dropped
   out, because a run that finds nothing has several causes that look identical. */

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
  const list = (deps && deps.list) ||
    ((resource, filter) => sm8ListOrAll(resource, { apiKey: cfg.apiKey, filter }));
  const now = (deps && deps.now) || Date.now();
  const out = [];
  const problems = [];
  const report = {};

  if (cfg.sources.includes("tasks")) {
    try {
      /* Ask only for open tasks assigned to me. On an account with thousands of
         records this is the difference between a handful and a truncated dump. */
      const res = await list("task", myOpenTasksFilter(cfg.staffUuid));
      const all = Array.isArray(res.records) ? res.records : [];
      // Filtered or not, the same rules decide — so a server that ignores the filter
      // still gives the right answer, just more slowly.
      const mine = tasksForStaff(all, cfg.staffUuid);
      report.tasks = {
        read: all.length, kept: mine.length, offered: 0,
        filtered: !!res.filtered, pages: res.pages || 1,
      };
      if (res.filterRejected) report.tasks.filterRejected = true;

      /* Nothing of mine. Take one more look — this time at everyone's open tasks —
         purely to be able to say whose they are. Narrow and paged, so it describes
         the work happening now rather than whatever the first page happened to hold. */
      if (mine.length === 0) {
        try {
          const everyone = await list("task", openTasksFilter());
          const live = (Array.isArray(everyone.records) ? everyone.records : [])
            .filter((t) => t.active !== 0 && t.active !== "0" && !isTaskDone(t));
          report.tasks.open = live.length;
          report.tasks.unassigned = live.filter((t) => !taskOwner(t)).length;

          const staff = await list("staff", null);
          const people = Array.isArray(staff.records) ? staff.records : [];
          const byUuid = new Map(people
            .map((s) => [s.uuid, `${s.first || ""} ${s.last || ""}`.trim() || s.email || s.uuid]));
          const nameFor = (uuid) => (uuid ? (byUuid.get(uuid) || "not in the staff list") : "nobody");

          report.tasks.you = byUuid.get(cfg.staffUuid) || null;
          report.tasks.staffCount = people.length;

          const counts = new Map();
          for (const t of live) {
            const key = nameFor(taskOwner(t));
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          report.tasks.byOwner = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([name, count]) => ({ name, count }));
          report.tasks.assignedTo = report.tasks.byOwner.map((o) => o.name);

          // Real records, newest first, so the reading can be checked against the source.
          report.tasks.sample = live
            .slice()
            .sort((a, b) => (sm8Time(b.edit_date) || 0) - (sm8Time(a.edit_date) || 0))
            .slice(0, 4)
            .map((t) => ({
              title: tidy(t.name || t.task_details || "", 48) || "(no name)",
              owner: nameFor(taskOwner(t)),
            }));
        } catch (e) {
          problems.push("who owns them: " + e.message);
        }
      }

      for (const t of mine) {
        const s = taskSuggestion(t, await getJob(jobUuidFor(t)));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("tasks: " + e.message); }
  }

  if (cfg.sources.includes("notes")) {
    try {
      // Notes cannot be filtered on their text, but they can at least be paged properly.
      const res = await list("note", "active eq 1");
      const all = Array.isArray(res.records) ? res.records : [];
      const hits = notesMentioning(all, cfg.names);
      report.notes = { read: all.length, kept: hits.length, offered: 0, pages: res.pages || 1 };
      if (!cfg.names || !cfg.names.length) report.notes.noNames = true;
      for (const n of hits) {
        const s = noteSuggestion(n, await getJob(jobUuidFor(n)));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("notes: " + e.message); }
  }

  if (cfg.sources.includes("emails")) {
    try {
      const res = await list("emailmessage", null);
      const all = Array.isArray(res.records) ? res.records : [];
      const inb = inboundEmails(all);
      report.emails = { read: all.length, kept: inb.length, offered: 0, pages: res.pages || 1 };
      for (const m of inb) {
        const s = emailSuggestion(m, await getJob(jobUuidFor(m)));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("emails: " + e.message); }
  }

  /* Newest first. It only matters when more turns up than a single check may take,
     but that is exactly the moment it matters most: what arrives should be the work
     that just landed, not whatever happened to be first in the list. */
  const fresh = recentOnly(out, cfg.lookbackMs, now).sort((a, b) => {
    const at = sm8Time(a.at), bt = sm8Time(b.at);
    if (isNaN(at) && isNaN(bt)) return 0;
    if (isNaN(at)) return 1;
    if (isNaN(bt)) return -1;
    return bt - at;
  });

  // How many of each kind made it all the way through the date window.
  for (const s of fresh) {
    const key = s.kind === "task" ? "tasks" : s.kind === "note" ? "notes" : "emails";
    if (report[key]) report[key].offered++;
  }

  return { suggestions: fresh, problems, report };
}
