/* The one place that decides what a notification says and when it fires.
   Imported by push-send.js; the same ids and labels are mirrored in index.html.

   Tone rules, deliberately: state the facts, never nag, never use an exclamation
   mark, and stay silent when there is nothing worth saying. A notification that
   fires on an empty day trains you to ignore the ones that matter. */

export const ROLLOVER_HOUR = 1; // the day turns at 1am, same as the app

// ---- date helpers, all in the subscriber's own timezone ----

export function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || "UTC",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: p.weekday, // "Mon" … "Sun"
  };
}

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function shiftDay(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// The "logical" day: before 1am you are still in yesterday.
export function logicalToday(parts) {
  const base = ymd(parts.y, parts.m, parts.d);
  return parts.hour < ROLLOVER_HOUR ? shiftDay(base, -1) : base;
}

export function logicalDayOfTimestamp(ts, tz) {
  return logicalToday(localParts(new Date(ts), tz));
}

// ---- reading the synced task blob ----

function listsFor(payload, which) {
  const out = [];
  if (which !== "personal") out.push({ name: "work", data: payload.work });
  if (which !== "work") out.push({ name: "personal", data: payload.personal });
  return out.filter((l) => l.data && Array.isArray(l.data.tasks));
}

/* Everything the message builders need, in one pass.
   Note the app rolls tasks over on the client, so if it hasn't been opened the
   dates may still read as yesterday. Anything dated on or before today counts as
   due, and anything dated strictly before today is treated as carried over. */
export function summarise(payload, which, today, tz) {
  const s = {
    open: [], carried: [], quick: [], doneToday: 0, doneWeek: 0,
    byList: {}, dueBack: [], held: [],
  };
  if (!payload) return s;

  const weekStart = shiftDay(today, -6);

  for (const { name, data } of listsFor(payload, which)) {
    const tasks = data.tasks || [];
    const completions = data.completions || [];
    // Held tasks are waiting on somebody else — not part of anything you can do today.
    const isHeld = (t) => !!(t.heldSince && t.status !== "done");
    const live = tasks.filter((t) => !isHeld(t));
    const open = live.filter((t) => t.status !== "done" && t.date <= today);
    const carried = live.filter(
      (t) => t.status !== "done" && (t.date < today || t.rolledOverOn === today)
    );
    const now = Date.now();
    const visible = open.filter((t) => !(t.snoozedUntil && t.snoozedUntil > now));

    s.held.push(...tasks.filter(isHeld).map((t) => ({ ...t, list: name })));

    s.open.push(...visible.map((t) => ({ ...t, list: name })));
    s.carried.push(...carried.map((t) => ({ ...t, list: name })));
    s.quick.push(...visible.filter((t) => t.quick).map((t) => ({ ...t, list: name })));

    const done = completions.filter(
      (c) => c.type !== "step" && logicalDayOfTimestamp(c.ts, tz) === today
    ).length;
    const week = completions.filter((c) => {
      if (c.type === "step") return false;
      const day = logicalDayOfTimestamp(c.ts, tz);
      return day >= weekStart && day <= today;
    }).length;

    s.doneToday += done;
    s.doneWeek += week;
    s.byList[name] = { open: visible.length, done };
  }

  const rank = (a, b) => (a.priority || 3) - (b.priority || 3);
  s.open.sort(rank);
  s.carried.sort(rank);
  s.held.sort((a, b) => (a.heldSince || 0) - (b.heldSince || 0)); // longest wait first
  return s;
}

// Whole days a task has been sitting on hold, in the subscriber's own timezone.
export function daysHeld(task, now, tz) {
  if (!task.heldSince) return 0;
  const from = logicalDayOfTimestamp(task.heldSince, tz);
  const to = logicalDayOfTimestamp(now.getTime(), tz);
  const ms = new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z");
  return Math.max(0, Math.round(ms / 86400000));
}

// ---- copy helpers ----

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function topLine(items) {
  if (!items.length) return "";
  const first = items[0].text || "";
  const rest = items.length - 1;
  if (!rest) return first;
  return `${first}, and ${rest} more`;
}

function splitNote(byList) {
  const w = byList.work ? byList.work.open : 0;
  const p = byList.personal ? byList.personal.open : 0;
  if (w && p) return `${w} work, ${p} personal`;
  return "";
}

function reflection(n) {
  if (n <= 2) return "A couple of things off your plate.";
  if (n <= 5) return "Nice work today.";
  if (n <= 9) return "That's a proper day's work.";
  return "That's a lot cleared — well done.";
}

/* Each type: when it fires, and what it says.
   `build` returns null to stay silent — that is the normal case on a quiet day. */
export const TYPES = [
  {
    id: "morning",
    label: "Morning brief",
    blurb: "What is waiting for you, and anything that carried over.",
    at: "07:30",
    build(s) {
      if (!s.open.length && !s.carried.length) return null;
      const title = s.carried.length
        ? `${plural(s.carried.length, "task", "tasks")} carried over`
        : `${plural(s.open.length, "task", "tasks")} for today`;
      const extra = splitNote(s.byList);
      const body = s.carried.length
        ? topLine(s.carried)
        : topLine(s.open) + (extra ? ` · ${extra}` : "");
      return { title, body };
    },
  },
  {
    id: "unplanned",
    label: "Nothing planned",
    blurb: "A quiet prompt on mornings where the day is still empty.",
    at: "09:00",
    build(s) {
      if (s.open.length) return null;
      return { title: "Nothing planned for today", body: "A good moment to set out what matters." };
    },
  },
  {
    id: "quick",
    label: "Quick wins",
    blurb: "Midday reminder when small jobs have piled up.",
    at: "13:00",
    build(s) {
      if (s.quick.length < 2) return null;
      return {
        title: `${plural(s.quick.length, "quick job", "quick jobs")} outstanding`,
        body: "Most of these take under a few minutes.",
      };
    },
  },
  {
    id: "holding",
    label: "Chase-ups",
    blurb: "One thing a day that is waiting on someone else, oldest first.",
    at: "10:00",
    build(s, opts) {
      const threshold = (opts && opts.holdDays) || 3;
      // Only things that have sat long enough to be worth a nudge.
      const stale = (s.staleHeld || []).filter((h) => h.days >= threshold);
      if (!stale.length) return null;
      // One at a time, longest wait first — a single thing to chase, not a list.
      const top = stale[0];
      const day = top.days === 1 ? "1 day" : `${top.days} days`;
      const title = top.waitingOn
        ? `Still waiting on ${top.waitingOn} — ${day}`
        : `On hold ${day}`;
      const rest = stale.length - 1;
      return {
        title: title.length > 60 ? `On hold ${day}` : title,
        body: top.text + (rest ? ` · ${rest} more on hold` : ""),
      };
    },
  },
  {
    id: "evening",
    label: "Evening nudge",
    blurb: "A late look at anything still open. Silent once you have cleared the list.",
    at: "18:00",
    build(s) {
      if (!s.open.length) return null;
      return {
        title: `${plural(s.open.length, "task", "tasks")} still open`,
        body: `Top one: ${topLine([s.open[0]])}`,
      };
    },
  },
  {
    id: "endofday",
    label: "End of day",
    blurb: "What you actually got done. Stays quiet if the day was a blank.",
    at: "21:00",
    build(s) {
      if (!s.doneToday) return null;
      return { title: `${plural(s.doneToday, "task", "tasks")} done today`, body: reflection(s.doneToday) };
    },
  },
  {
    id: "weekly",
    label: "Weekly recap",
    blurb: "Sunday evening summary of the week just gone.",
    at: "18:30",
    weekday: "Sun",
    build(s) {
      if (!s.doneWeek) return null;
      const carrying = s.open.length ? ` · ${s.open.length} going into next week` : "";
      return { title: `${plural(s.doneWeek, "task", "tasks")} done this week`, body: `A week's work${carrying}.` };
    },
  },
  {
    id: "snoozed",
    label: "Snoozed task returns",
    blurb: "When a task you sent away for a while comes back. Only applies if you use timed snoozes.",
    continuous: true, // checked every run rather than at a fixed hour
    build(s) {
      if (!s.dueBack.length) return null;
      const first = s.dueBack[0];
      return {
        title: "Back on the list",
        body: s.dueBack.length > 1 ? `${first.text}, and ${s.dueBack.length - 1} more` : first.text,
      };
    },
  },
];

export const TYPE_IDS = TYPES.map((t) => t.id);

export function defaultPrefs() {
  // Start conservative: the two that are genuinely useful, nothing else.
  return {
    lists: "both",
    holdDays: 3,
    types: { morning: true, unplanned: false, quick: false, evening: true, endofday: false, weekly: false, snoozed: false, holding: true },
  };
}

// Does this type's slot fall inside the window we are currently checking?
export function slotIsDue(type, parts, windowMinutes) {
  if (type.continuous) return true;
  if (type.weekday && type.weekday !== parts.weekday) return false;
  const [h, m] = type.at.split(":").map(Number);
  const slot = h * 60 + m;
  const now = parts.hour * 60 + parts.minute;
  return now >= slot && now < slot + windowMinutes;
}

export const WINDOW_MINUTES = 20; // slot width, a little wider than the cron gap

/* Works out everything a single subscriber should receive right now.
   Pure: no network, no storage — which is what makes it testable. */
export function decide(record, now, taskPayload) {
  const tz = record.tz || "UTC";
  const parts = localParts(now, tz);
  const today = logicalToday(parts);
  const prefs = record.prefs || {};
  const enabled = prefs.types || {};
  const sent = Object.assign({}, record.sent || {});
  const lists = prefs.lists || "both";

  const summary = summarise(taskPayload, lists, today, tz);
  // Ages are worked out here so the message builder stays pure.
  summary.staleHeld = summary.held.map((h) => ({
    text: h.text || "",
    waitingOn: h.waitingOn || null,
    days: daysHeld(h, now, tz),
  })).sort((a, b) => b.days - a.days);

  // Anything whose snooze ran out since we last looked.
  const since = record.lastSnoozeCheck || 0;
  const nowMs = now.getTime();
  if (enabled.snoozed && taskPayload) {
    for (const listName of ["work", "personal"]) {
      if (lists === "work" && listName === "personal") continue;
      if (lists === "personal" && listName === "work") continue;
      const data = taskPayload[listName];
      if (!data || !Array.isArray(data.tasks)) continue;
      for (const t of data.tasks) {
        if (t.status === "done" || !t.snoozedUntil) continue;
        if (t.snoozedUntil > since && t.snoozedUntil <= nowMs) summary.dueBack.push(t);
      }
    }
  }

  const messages = [];
  for (const type of TYPES) {
    if (!enabled[type.id]) continue;
    if (!slotIsDue(type, parts, WINDOW_MINUTES)) continue;
    // One of each per day. The continuous ones dedupe on content instead.
    if (!type.continuous && sent[type.id] === today) continue;

    const message = type.build(summary, prefs);
    // Mark the slot used either way, so a quiet day isn't re-checked all morning.
    if (!type.continuous) sent[type.id] = today;
    if (message) messages.push({ id: type.id, ...message });
  }

  return { messages, sent, today, checkedAt: nowMs };
}
