/* Combining what two devices did, rather than letting the later one win.

   Sync used to be a straight overwrite: whatever a device sent replaced whatever was
   stored. With one person and two devices that is almost always fine, because only one
   of them is being used at a time. With two people on one list it is not fine at all —
   it quietly destroys work, and the person whose afternoon vanished has no way of
   knowing why. So the server merges instead.

   The rules, in order of how much they matter:

   1. A task is identified by its id, and the most recently changed version wins.
   2. A deletion is a fact with a time on it, kept as a tombstone. Without that, the
      other device simply pushes the task back and it returns from the dead.
   3. Completions are only ever added, never removed, and deduped by id.
   4. Anything with no timestamp at all is treated as older than anything with one,
      so a device running an older version can never overwrite fresher work.

   No dependencies here, so it can be tested without a blob store behind it. */

export const TOMBSTONE_DAYS = 45;   // long enough that no real device is that far behind
export const MAX_COMPLETIONS = 600;

const timeOf = (rec) => {
  const n = Number(rec && rec.updatedAt);
  return isFinite(n) && n > 0 ? n : 0;
};

export function emptyList() {
  return { tasks: [], completions: [], people: [], deleted: [], containers: [] };
}

function asList(v) {
  const l = v && typeof v === "object" ? v : {};
  return {
    tasks: Array.isArray(l.tasks) ? l.tasks : [],
    completions: Array.isArray(l.completions) ? l.completions : [],
    people: Array.isArray(l.people) ? l.people : [],
    deleted: Array.isArray(l.deleted) ? l.deleted : [],
    /* Customers and jobs. A device running an older build sends no `containers` key
       at all — which must read as "I have nothing to say about these", not as "there
       are none". Defaulting to an empty array does exactly that, because merging
       against empty leaves the other side's containers untouched. */
    containers: Array.isArray(l.containers) ? l.containers : [],
  };
}

/* Tombstones, newest first, with anything ancient dropped. A tombstone only has to
   outlive the slowest device that might still be holding the task. */
function mergeTombstones(a, b, now) {
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  const byId = new Map();
  for (const t of a.concat(b)) {
    if (!t || !t.id) continue;
    const at = Number(t.at) || 0;
    if (at < cutoff) continue;
    const seen = byId.get(t.id);
    if (!seen || at > seen.at) byId.set(t.id, { id: t.id, at: at });
  }
  return Array.from(byId.values());
}

/* One rule, used for both tasks and containers: keep the most recently changed copy
   of each id, and drop anything a tombstone says was deleted after that change. */
function newestById(records, deadAt) {
  const byId = new Map();
  for (const rec of records) {
    if (!rec || !rec.id) continue;
    const gone = deadAt.get(rec.id);
    if (gone !== undefined && gone >= timeOf(rec)) continue;
    const seen = byId.get(rec.id);
    if (!seen || timeOf(rec) > timeOf(seen)) byId.set(rec.id, rec);
  }
  return byId;
}

export function mergeList(mine, theirs, now) {
  const t = now || Date.now();
  const a = asList(mine);
  const b = asList(theirs);

  const deleted = mergeTombstones(a.deleted, b.deleted, t);
  const deadAt = new Map(deleted.map((d) => [d.id, d.at]));

  // Tasks: newest change wins; a tombstone newer than the task wins over both.
  const byId = newestById(a.tasks.concat(b.tasks), deadAt);
  /* Containers follow the identical rule, and share the same tombstone list — ids are
     unique across both, so one record of "this was deleted at 4pm" serves either. */
  const containers = newestById(a.containers.concat(b.containers), deadAt);

  /* Completions are a log of things that happened. Two people finishing two tasks is
     two events, and neither should erase the other, so they are only ever added to. */
  const comps = new Map();
  for (const c of a.completions.concat(b.completions)) {
    if (!c) continue;
    const key = c.id || (String(c.text) + "|" + String(c.ts));
    if (!comps.has(key)) comps.set(key, c);
  }
  const completions = Array.from(comps.values())
    .sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0))
    .slice(-MAX_COMPLETIONS);

  return {
    tasks: Array.from(byId.values()),
    completions: completions,
    people: mergePeople(a.people, b.people),
    deleted: deleted,
    containers: Array.from(containers.values()),
  };
}

/* People are a small shared roster. Renaming somebody on one device should carry, and
   removing them should not be undone by a device that had not heard about it yet.

   So a removed person is KEPT here, carrying `removed: true`. Filtering them out at
   this point would throw away the very fact that records the removal, and the other
   device — still holding them as present, with an older timestamp — would win the next
   merge and put them back. The app filters them out when drawing the roster instead.
   They cost a few bytes each and there are never many. */
export function mergePeople(a, b) {
  const byId = new Map();
  for (const p of a.concat(b)) {
    if (!p || !p.id) continue;
    const seen = byId.get(p.id);
    if (!seen || timeOf(p) > timeOf(seen)) byId.set(p.id, p);
  }
  return Array.from(byId.values())
    .sort((x, y) => (Number(x.addedAt) || 0) - (Number(y.addedAt) || 0));
}

// The people actually on the list, for anything that shows them.
export function livePeople(list) {
  return (list || []).filter((p) => p && !p.removed);
}

/* Suppliers are not part of any one list — they are reference data for the whole
   device, so they hang off the payload rather than off work or personal.

   A removed supplier is kept carrying `removed: true`, for the same reason a removed
   person is: the record of the removal is the only thing that stops the other device,
   which still has it, from putting it back on the next merge. */
export function mergeSuppliers(a, b) {
  const byId = new Map();
  for (const s of (a || []).concat(b || [])) {
    if (!s || !s.id) continue;
    const seen = byId.get(s.id);
    if (!seen || timeOf(s) > timeOf(seen)) byId.set(s.id, s);
  }
  return Array.from(byId.values());
}

export function liveSuppliers(list) {
  return (list || []).filter((s) => s && !s.removed);
}

/* The whole payload: whatever lists it happens to hold, plus the moment it was written.

   It used to name `work` and `personal` outright. It cannot any more, because a team
   code carries one shared list and nothing else — naming the two profiles would have
   meant sending a colleague an empty `personal` key alongside, which is a strange thing
   to hand somebody and one refactor away from not being empty.

   `updatedAt` on the payload is only ever used to decide whether a device needs to
   redraw. It plays no part in deciding which task wins — that is per task, which is
   the entire point. */
export function mergePayload(stored, incoming, now) {
  const t = now || Date.now();
  const s = stored && typeof stored === "object" ? stored : {};
  const i = incoming && typeof incoming === "object" ? incoming : {};

  const keys = [];
  for (const k of Object.keys(s).concat(Object.keys(i))) {
    if (k !== "updatedAt" && keys.indexOf(k) === -1) keys.push(k);
  }

  const out = { updatedAt: t };
  for (const k of keys) {
    /* Every other key is a list of tasks; suppliers are a flat roster and would be
       quietly emptied by mergeList, which looks for a `tasks` array and finds none. */
    if (k === "suppliers") { out.suppliers = mergeSuppliers(s.suppliers, i.suppliers); continue; }
    out[k] = mergeList(s[k], i[k], t);
  }
  return out;
}
