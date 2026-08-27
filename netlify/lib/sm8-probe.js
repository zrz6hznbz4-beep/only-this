import { sm8List, sm8Time } from "./servicem8.js";

/* Asking ServiceM8 the same question several ways, and reporting what each one gives.

   This exists because five rounds of reasoning about why a query returned too little
   were five rounds of guessing. The API documents `task_complete` as a string, but
   whether a filter must compare it as '0' or 0 is not something the documentation
   settles and not something worth another theory. So: try them all, count what comes
   back, and let the numbers say which is right.

   It runs only when asked. Nothing here is on the fifteen-minute schedule. */

// Ten small counting queries, well inside the 180-per-minute limit.
export function probeSet(staffUuid) {
  const who = String(staffUuid || "").replace(/'/g, "");
  return [
    { id: "all", label: "every task, no filter at all", filter: null },
    { id: "active", label: "active eq 1", filter: "active eq 1" },
    { id: "openQ", label: "task_complete eq '0'  (as text)", filter: "task_complete eq '0'" },
    { id: "openN", label: "task_complete eq 0  (as a number)", filter: "task_complete eq 0" },
    { id: "doneQ", label: "task_complete eq '1'  (as text)", filter: "task_complete eq '1'" },
    { id: "activeOpenQ", label: "active eq 1 and task_complete eq '0'",
      filter: "active eq 1 and task_complete eq '0'" },
    { id: "activeOpenN", label: "active eq 1 and task_complete eq 0",
      filter: "active eq 1 and task_complete eq 0" },
    { id: "mine", label: "assigned_to_staff_uuid eq me",
      filter: who ? "assigned_to_staff_uuid eq '" + who + "'" : null, skip: !who },
    { id: "mineOpenQ", label: "mine and active eq 1 and task_complete eq '0'",
      filter: who ? "active eq 1 and task_complete eq '0' and assigned_to_staff_uuid eq '" + who + "'" : null,
      skip: !who },
    { id: "mineOpenN", label: "mine and active eq 1 and task_complete eq 0",
      filter: who ? "active eq 1 and task_complete eq 0 and assigned_to_staff_uuid eq '" + who + "'" : null,
      skip: !who },
  ];
}

/* The fields that decide anything, copied verbatim. Deliberately not task_details:
   that is where the long free text lives, and none of it is needed to read a record's
   state. Nothing here is invented, tidied or reinterpreted. */
const KEEP = ["uuid", "name", "active", "task_complete", "completed_timestamp",
  "completed_by_staff_uuid", "assigned_to_staff_uuid", "staff_uuid", "allocated_staff_uuid",
  "related_object", "related_object_uuid", "job_uuid", "edit_date", "create_date", "due_date"];

function bareRecord(t) {
  const out = {};
  for (const k of KEEP) if (t[k] !== undefined) out[k] = t[k];
  // Anything unexpected is worth knowing about, so note the names of other fields.
  const extra = Object.keys(t).filter((k) => KEEP.indexOf(k) === -1 && k !== "task_details");
  if (extra.length) out["(other fields present)"] = extra.join(", ");
  return out;
}

export async function probeTasks(cfg, deps) {
  const list = (deps && deps.list) ||
    ((resource, filter) => sm8List(resource, { apiKey: cfg.apiKey, filter, maxPages: 3 }));

  const counts = [];
  let widest = null;

  for (const p of probeSet(cfg.staffUuid)) {
    if (p.skip) { counts.push({ label: p.label, skipped: true }); continue; }
    try {
      const rows = await list("task", p.filter);
      const records = Array.isArray(rows.records) ? rows.records : rows;
      counts.push({ label: p.label, count: records.length, pages: rows.pages || 1 });
      // Keep the biggest successful result to draw examples from.
      if (!widest || records.length > widest.length) widest = records;
    } catch (e) {
      counts.push({ label: p.label, error: e && e.status ? "HTTP " + e.status : String(e && e.message) });
    }
  }

  let staff = [];
  try {
    const s = await list("staff", null);
    const rows = Array.isArray(s.records) ? s.records : s;
    staff = rows.map((x) => ({
      uuid: x.uuid,
      name: `${x.first || ""} ${x.last || ""}`.trim() || x.email || "(unnamed)",
      active: x.active,
    }));
  } catch (e) {
    staff = [{ error: String(e && e.message) }];
  }

  // The most recently touched records, whole, so their real shape is visible.
  const newest = (widest || []).slice()
    .sort((a, b) => (sm8Time(b.edit_date) || 0) - (sm8Time(a.edit_date) || 0))
    .slice(0, 5)
    .map(bareRecord);

  return {
    takenAt: new Date().toISOString(),
    settingsStaffUuid: cfg.staffUuid || null,
    counts,
    staff,
    newestRecords: newest,
  };
}
