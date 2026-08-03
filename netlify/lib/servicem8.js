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

/* A task assigned to you in ServiceM8. */
export function taskSuggestion(task, job) {
  const name = tidy(task.name || task.task || task.description || "", 90);
  if (!name) return null;
  return {
    id: "sm8-task-" + task.uuid,
    source: "servicem8",
    kind: "task",
    kindLabel: "Task assigned to you",
    title: name,
    subtasks: suggestSubtasks(task.description !== name ? task.description : ""),
    context: jobLabel(job),
    url: jobUrl(job),
    at: task.edit_date || task.date || null,
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

export function tasksForStaff(tasks, staffUuid) {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => {
    if (!t || t.active === 0 || t.active === "0") return false;
    if (t.status === "Completed" || t.completed === 1 || t.completed === "1") return false;
    const owner = t.assigned_to_staff_uuid || t.staff_uuid || t.allocated_staff_uuid;
    return owner && owner === staffUuid;
  });
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

// Anything older than this on first run would be noise rather than news.
export function recentOnly(records, sinceMs, now) {
  const cutoff = (now || Date.now()) - sinceMs;
  return (records || []).filter((r) => {
    const when = Date.parse(r.at || r.edit_date || r.date || "");
    return isNaN(when) ? true : when >= cutoff;
  });
}
