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

/* Listing a whole resource properly.

   Two things make a plain GET of task.json wrong, and both are quiet about it:

   1. A response holds at most a thousand records. Beyond that you get a slice, with
      nothing in the body to say so — an account with years of history hands back a
      pile of finished work from 2023 and none of this week's.
   2. The API can filter server-side, so fetching everything to discard 99% of it is
      not just slow, it is what makes the truncation bite.

   So: filter at the source, and follow the x-next-cursor header to the end. */
const PAGE_LIMIT = 12;   // 12,000 records is far past anything sensible; a guard, not a target

export async function sm8List(resource, opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || fetch;
  let cursor = "-1";
  const out = [];
  let pages = 0;

  for (; pages < PAGE_LIMIT; pages++) {
    let url = `${API}/${resource}.json?cursor=${encodeURIComponent(cursor)}`;
    if (o.filter) url += `&%24filter=${encodeURIComponent(o.filter)}`;

    const res = await doFetch(url, {
      headers: { "X-API-Key": o.apiKey, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const err = new Error(`ServiceM8 ${resource} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (Array.isArray(data)) out.push.apply(out, data);

    const next = res.headers && typeof res.headers.get === "function"
      ? res.headers.get("x-next-cursor") : null;
    if (!next) { pages++; break; }
    cursor = next;
  }

  out.pages = pages;
  return out;
}

/* A filter the server rejects must not mean no work at all.

   Field names are case-sensitive and vary by resource, so a filter that is wrong comes
   back as a 400 rather than as an empty list. Falling back to the unfiltered — but
   still paginated — call keeps things working, and says which route it took so the
   app can tell you. */
export async function sm8ListOrAll(resource, opts) {
  const o = opts || {};
  if (!o.filter) {
    const all = await sm8List(resource, o);
    return { records: all, filtered: false, pages: all.pages };
  }
  try {
    const rows = await sm8List(resource, o);
    return { records: rows, filtered: true, pages: rows.pages };
  } catch (e) {
    if (e && e.status === 400) {
      const all = await sm8List(resource, Object.assign({}, o, { filter: null }));
      return { records: all, filtered: false, pages: all.pages, filterRejected: true };
    }
    throw e;
  }
}

// Values go inside single quotes, so a stray quote would break the expression.
const q = (v) => "'" + String(v == null ? "" : v).replace(/'/g, "") + "'";

/* Only open tasks, and only mine. Three conditions of the ten allowed, all on fields
   the reference documents for Task. */
export function myOpenTasksFilter(staffUuid) {
  if (!staffUuid) return null;
  return "active eq 1 and task_complete eq '0' and assigned_to_staff_uuid eq " + q(staffUuid);
}

// Open tasks belonging to anyone — used only to explain a run that found nothing.
export function openTasksFilter() {
  return "active eq 1 and task_complete eq '0'";
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

/* Finished means task_complete = "1". Nothing else.

   There were three extra signals here — completed_timestamp, status, completed — added
   as a safety net on the theory that more checks meant fewer mistakes. The opposite was
   true: each one was another way to wrongly discard a task, and two of them did exactly
   that, silently, across an entire account. A belt and braces made of guesses is worse
   than the one documented field on its own.

   So the rule is now: it is finished only if ServiceM8 says so in the field ServiceM8
   documents. Anything unrecognised counts as open, because wrongly offering a finished
   task costs one tap, while wrongly hiding a live one is invisible. */
export function isTaskDone(t) {
  if (!t) return false;
  const flag = t.task_complete;
  return flag === 1 || flag === "1" || flag === true;
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
