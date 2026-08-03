import {
  sm8Get, taskSuggestion, noteSuggestion, emailSuggestion,
  tasksForStaff, notesMentioning, inboundEmails, recentOnly,
  jobUuidFor, isTaskDone, taskOwner, sm8Time, tidy,
} from "./servicem8.js";

/* Deciding what is worth offering. Kept apart from the function that runs it so it
   can be tested against a stand-in ServiceM8 rather than the real one.

   Alongside the suggestions it keeps a tally of what it saw and where things dropped
   out. Without that, a run that finds nothing is indistinguishable from a run that
   found plenty and threw it all away — and those need completely different fixes. */

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
  const report = {};

  // Count what survives each stage, so the app can say which stage lost it.
  const stage = (key, read, kept) => { report[key] = { read, kept, offered: 0 }; };

  if (cfg.sources.includes("tasks")) {
    try {
      const tasks = await get("task.json");
      const all = Array.isArray(tasks) ? tasks : [];
      const mine = tasksForStaff(all, cfg.staffUuid);
      stage("tasks", all.length, mine.length);

      /* The most common setup mistake by a wide margin: tasks exist, but they belong
         to a different staff member than the one picked. Worth one extra call to be
         able to say whose they are rather than leaving it as a mystery. */
      if (all.length > 0 && mine.length === 0) {
        const deleted = all.filter((t) => t.active === 0 || t.active === "0");
        const live = all.filter((t) => t.active !== 0 && t.active !== "0" && !isTaskDone(t));
        /* Kept apart rather than lumped into one "not available" figure. When these
           were reported as a single verdict, a bug that misread every task as finished
           came out as a confident statement of fact. Separate numbers make a wrong one
           visibly wrong. */
        report.tasks.open = live.length;
        report.tasks.done = all.length - deleted.length - live.length;
        report.tasks.deleted = deleted.length;
        report.tasks.unassigned = live.filter((t) => !taskOwner(t)).length;
        try {
          const staff = await get("staff.json");
          const list = Array.isArray(staff) ? staff : [];
          const byUuid = new Map(list
            .map((s) => [s.uuid, `${s.first || ""} ${s.last || ""}`.trim() || s.email || s.uuid]));
          const nameFor = (uuid) => (uuid ? (byUuid.get(uuid) || "not in the staff list") : "nobody");

          /* Who the app currently thinks you are, by name. If this comes back empty the
             stored UUID is not a staff member at all, which is worth knowing on its own. */
          report.tasks.you = byUuid.get(cfg.staffUuid) || null;
          report.tasks.staffCount = list.length;

          // A tally per person rather than a bare list of names — "everything belongs to
          // one person" and "it is spread about" need different responses from you.
          const counts = new Map();
          for (const t of live) {
            const key = nameFor(taskOwner(t));
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          report.tasks.byOwner = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([name, count]) => ({ name, count }));

          /* A few actual task names with who they belong to. This is the one thing that
             settles it: put it beside the list in ServiceM8 and either the names match
             and the reading is right, or they do not and it is wrong. */
          report.tasks.sample = live.slice(0, 4).map((t) => ({
            title: tidy(t.name || t.task_details || "", 48) || "(no name)",
            owner: nameFor(taskOwner(t)),
          }));
          report.tasks.assignedTo = report.tasks.byOwner.map((o) => o.name);

          /* The raw fields on tasks this decided were finished, newest first.

             Twice now a wrong guess about which field means "complete" has quietly
             thrown away almost everything, and both times it was invisible from here.
             Showing the actual values means the next wrong guess is one glance to
             spot rather than another round of theories. */
          report.tasks.excluded = all
            .filter((t) => t.active !== 0 && t.active !== "0" && isTaskDone(t))
            .sort((a, b) => (sm8Time(b.edit_date) || 0) - (sm8Time(a.edit_date) || 0))
            .slice(0, 4)
            .map((t) => ({
              title: tidy(t.name || "", 34) || "(no name)",
              fields: [
                "task_complete=" + JSON.stringify(t.task_complete),
                "completed_timestamp=" + JSON.stringify(t.completed_timestamp),
                "active=" + JSON.stringify(t.active),
              ].join("  "),
            }));
        } catch (e) {
          report.tasks.assignedTo = [];
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
      const notes = await get("note.json");
      const all = Array.isArray(notes) ? notes : [];
      const hits = notesMentioning(all, cfg.names);
      stage("notes", all.length, hits.length);
      if (!cfg.names || !cfg.names.length) report.notes.noNames = true;
      for (const n of hits) {
        const s = noteSuggestion(n, await getJob(jobUuidFor(n)));
        if (s) out.push(s);
      }
    } catch (e) { problems.push("notes: " + e.message); }
  }

  if (cfg.sources.includes("emails")) {
    try {
      const messages = await get("emailmessage.json");
      const all = Array.isArray(messages) ? messages : [];
      const inb = inboundEmails(all);
      stage("emails", all.length, inb.length);
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
