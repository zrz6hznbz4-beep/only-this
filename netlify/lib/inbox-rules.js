/* The queue rules, kept free of any dependency so they can be tested on their own.
   inbox-store.js adds the storage around these. */

export const MAX_PENDING = 40;   // a runaway poller should not produce an infinite queue
export const SEEN_LIMIT = 400;   // keep the dedupe list from growing without bound

/* How many may arrive from a single check.

   A real account can hold thousands of tasks, and connecting for the first time must
   not turn into forty things to answer before you can use your plan. Anything held
   back is simply not marked as seen, so it comes round again on the next check and
   arrives a few at a time instead of all at once. */
export const MAX_NEW_PER_RUN = 8;

export function emptyInbox() {
  return { pending: [], seen: [], updatedAt: 0 };
}

/* Add suggestions that have not been offered before.
   `seen` holds the source id of everything ever offered, accepted or dismissed, so a
   poller running every fifteen minutes does not keep re-suggesting the same job.

   Suggestions should arrive newest first: when more turn up than one run may take,
   the most recent are the ones worth having now. */
export function mergeSuggestions(inbox, suggestions, limit) {
  const cap = limit === undefined ? MAX_NEW_PER_RUN : limit;
  const seen = new Set(inbox.seen || []);
  const pendingIds = new Set((inbox.pending || []).map((s) => s.id));
  const added = [];
  let held = 0;

  for (const s of suggestions) {
    if (!s || !s.id) continue;
    if (seen.has(s.id) || pendingIds.has(s.id)) continue;
    // Over the cap: leave it unseen so the next check picks it up again.
    if (added.length >= cap) { held++; continue; }
    added.push(s);
    seen.add(s.id);
  }

  return {
    pending: (inbox.pending || []).concat(added),
    seen: Array.from(seen),
    added: added.length,
    held,
  };
}

// Accepting or dismissing both just take it off the queue — `seen` already has the id,
// so it will not come back.
export function resolveSuggestion(inbox, id) {
  const before = (inbox.pending || []).length;
  const pending = (inbox.pending || []).filter((s) => s.id !== id);
  return { pending, seen: inbox.seen || [], removed: before !== pending.length };
}
