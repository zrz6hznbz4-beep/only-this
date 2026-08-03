/* The queue rules, kept free of any dependency so they can be tested on their own.
   inbox-store.js adds the storage around these. */

export const MAX_PENDING = 40;   // a runaway poller should not produce an infinite queue
export const SEEN_LIMIT = 400;   // keep the dedupe list from growing without bound

export function emptyInbox() {
  return { pending: [], seen: [], updatedAt: 0 };
}

/* Add suggestions that have not been offered before.
   `seen` holds the source id of everything ever offered, accepted or dismissed, so a
   poller running every fifteen minutes does not keep re-suggesting the same job. */
export function mergeSuggestions(inbox, suggestions) {
  const seen = new Set(inbox.seen || []);
  const pendingIds = new Set((inbox.pending || []).map((s) => s.id));
  const added = [];

  for (const s of suggestions) {
    if (!s || !s.id) continue;
    if (seen.has(s.id) || pendingIds.has(s.id)) continue;
    added.push(s);
    seen.add(s.id);
  }

  return {
    pending: (inbox.pending || []).concat(added),
    seen: Array.from(seen),
    added: added.length,
  };
}

// Accepting or dismissing both just take it off the queue — `seen` already has the id,
// so it will not come back.
export function resolveSuggestion(inbox, id) {
  const before = (inbox.pending || []).length;
  const pending = (inbox.pending || []).filter((s) => s.id !== id);
  return { pending, seen: inbox.seen || [], removed: before !== pending.length };
}
