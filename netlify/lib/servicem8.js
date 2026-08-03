/* Reading ServiceM8 and turning what comes back into task suggestions.

   Authentication is a private API key in the X-API-Key header — no OAuth app to
   register, no consent flow. The trade-off is that webhooks are not available to
   private applications, so this polls instead.

   Everything below the fetch helpers is pure: given records, produce suggestions.
   That is the part worth testing, and it can be tested without the network. */

const API = "https://api.servicem8.com/api_1.0";

export async function sm8Get(path, apiKey, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(`${API}/${path}`, {
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`ServiceM8 ${path} returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

// ---- tidying up the text ServiceM8 gives us ----

export function tidy(text, max) {
  const clean = String(text == null ? "" : text)
    .replace(/<[^>]*>/g, " ")        // job descriptions can carry markup
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!max || clean.length <= max) return clean;
  // Cut at a word boundary rather than mid-word.
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, "") + "…";
}

// The first sentence usually says what the thing actually is.
export function firstLine(text, max) {
  const clean = tidy(text);
  const stop = clean.search(/[.!?](\s|$)/);
  const line = stop > 10 ? clean.slice(0, stop) : clean;
  return tidy(line, max || 70);
}

/* A job's description often reads as a list — lines, bullets, or "and then" steps.
   Where that is obviously the case, offer them as subtasks. Where it is one solid
   paragraph, offer nothing rather than chopping a sentence in half. */
export function suggestSubtasks(text, limit) {
  const raw = String(text == null ? "" : text).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
  const lines = raw
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").trim())
    // Short steps are real — "Fit", "Test" — so only drop the truly empty ones.
    .filter((l) => l.length >= 3 && l.length < 120);

  if (lines.length < 2) return [];
  return lines.slice(0, limit || 5).map((l) => tidy(l, 80));
}

// ---- turning records into suggestions ----

const jobLabel = (job) => {
  if (!job) return "";
  const num = job.generated_job_id || job.job_number || "";
  const who = tidy(job.company_name || job.client_name || "", 40);
  if (num && who) return `Job ${num} · ${who}`;
  return num ? `Job ${num}` : who;
};

const jobUrl = (job) => (job && job.uuid ? `https://go.servicem8.com/OpenJob/${job.uuid}` : null);

/* A task assigned to you in ServiceM8. The longer write-up is `task_details`; `name`
   is the one-liner, and is the only field ServiceM8 insists on. */
export function taskSuggestion(task, job) {
  const name = tidy(task.name || task.task || task.description || "", 90);
  if (!name) return null;
  const detail = task.task_details || task.description || "";
  return {
    id: "sm8-task-" + task.uuid,
    source: "servicem8",
    kind: "task",
    kindLabel: "Task assigned to you",
    title: name,
    subtasks: suggestSubtasks(detail === name ? "" : detail),
    context: jobLabel(job),
    url: jobUrl(job),
    at: task.edit_date || task.create_date || task.date || null,
  };
}

/* A note on a job that mentions you. ServiceM8 has no formal @mention, so this is a
   name match — which is why the phrase that matched is worth keeping in the title. */
export function noteSuggestion(note, job) {
  // Keep the raw text for step detection — tidying collapses the line breaks that
  // tell us whether this is a list or a paragraph.
  const raw = note.note || note.text || "";
  const body = tidy(raw, 400);
  if (!body) return null;
  return {
    id: "sm8-note-" + note.uuid,
    source: "servicem8",
    kind: "note",
    kindLabel: "You were mentioned in a note",
    title: firstLine(raw.split(/\n/)[0] || raw, 70),
    subtasks: suggestSubtasks(raw),
    context: jobLabel(job),
    url: jobUrl(job),
    at: note.edit_date || note.date || null,
  };
}

/* An inbound email on a job — the reply to something you sent. */
export function emailSuggestion(message, job) {
  const subject = tidy(message.subject || "", 70);
  const from = tidy(message.from_name || message.from || message.sender || "", 40);
  if (!subject && !from) return null;
  const who = from ? from.split("<")[0].trim() : "";
  return {
    id: "sm8-email-" + (message.uuid || message.id),
    source: "servicem8",
    kind: "email",
    kindLabel: "Reply to an email you sent",
    title: who ? `Reply to ${who} — ${subject}` : `Reply — ${subject}`,
    subtasks: [],
    context: jobLabel(job),
    url: jobUrl(job),
    at: message.date || message.edit_date || null,
  };
}

// ---- filters ----

/* "Empty" in ServiceM8 is not an empty string.

   An unset date comes back as the MySQL zero date "0000-00-00 00:00:00", and an unset
   reference as an all-zero UUID. Both are perfectly truthy in Javascript, so testing
   these fields for presence marks every record as having one. That is exactly how an
   account with 1725 live tasks came back reporting all of them complete. */
const ZERO_DATE = /^0{4}-0{2}-0{2}([ T]0{2}:0{2}:0{2})?$/;
const ZERO_UUID = /^[0-]+$/;

export function hasValue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (ZERO_DATE.test(s) || ZERO_UUID.test(s)) return false;
  return true;
}

/* ServiceM8 marks a finished task with task_complete = "1", and fills in a
   completed_timestamp beside it. task_complete is the documented field and the one to
   trust; the rest are a belt and braces, and each must be a real value, not a zero one. */
export function isTaskDone(t) {
  if (!t) return false;
  if (t.task_complete === 1 || t.task_complete === "1" || t.task_complete === true) return true;
  if (hasValue(t.completed_timestamp)) return true;
  return t.status === "Completed" || t.completed === 1 || t.completed === "1";
}

export function taskOwner(t) {
  if (!t) return "";
  for (const v of [t.assigned_to_staff_uuid, t.staff_uuid, t.allocated_staff_uuid]) {
    if (hasValue(v)) return String(v).trim();
  }
  return "";
}

export function tasksForStaff(tasks, staffUuid) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => {
    if (!t || t.active === 0 || t.active === "0") return false;
    if (isTaskDone(t)) return false;
    return !!staffUuid && taskOwner(t) === staffUuid;
  });
}

/* A task points at whatever it is attached to through related_object / related_object_uuid,
   so only follow it when that thing is actually a job. Following it blindly meant asking
   ServiceM8 for a job using a client's UUID. */
export function jobUuidFor(rec) {
  if (!rec) return null;
  if (hasValue(rec.job_uuid)) return rec.job_uuid;
  const kind = String(rec.related_object || "").toLowerCase();
  if (hasValue(rec.related_object_uuid) && (!kind || kind === "job")) return rec.related_object_uuid;
  return null;
}

// A name match, case-insensitive, on whole words so "Nat" does not match "Nathaniel".
export function notesMentioning(notes, names) {
  if (!Array.isArray(notes) || !names || !names.length) return [];
  const patterns = names
    .map((n) => String(n).trim())
    .filter(Boolean)
    .map((n) => new RegExp("(^|[^a-z0-9])" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i"));
  return notes.filter((note) => {
    if (!note || note.active === 0 || note.active === "0") return false;
    const body = String(note.note || note.text || "");
    return patterns.some((re) => re.test(body));
  });
}

export function inboundEmails(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (!m) return false;
    const dir = String(m.direction || m.type || "").toLowerCase();
    if (dir) return dir.includes("in") || dir.includes("received");
    // Some records carry no direction; fall back to having a sender but no recipient.
    return !!(m.from || m.from_name || m.sender) && !m.to;
  });
}

/* ServiceM8 timestamps look like "2026-08-03 19:22:00" — a space instead of a T, and
   no timezone at all. Date.parse will take that, but reads it as the *server's* local
   time, which on a deployed function is UTC. Since the account's clock may be hours
   away from that, a timestamp is only ever accurate to within a day either way, so
   nothing here should ever depend on it more finely than that. */
export function sm8Time(value) {
  if (!hasValue(value)) return NaN;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return Date.UTC(+d[1], +d[2] - 1, +d[3]);
  return Date.parse(s);
}

/* Anything older than this on first run would be noise rather than news.

   The window is padded by a day, because the account's timezone is unknown here and
   an hours-off reading must never be the reason something you just created fails to
   appear. Undated records are kept — being unsure is not a reason to hide something. */
const TZ_SLACK = 24 * 3600000;

export function recentOnly(records, sinceMs, now) {
  const t = now || Date.now();
  const cutoff = t - sinceMs - TZ_SLACK;
  return (records || []).filter((r) => {
    const when = sm8Time(r.at || r.edit_date || r.date);
    return isNaN(when) ? true : when >= cutoff;
  });
}
