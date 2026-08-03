import { getStore } from "@netlify/blobs";
import { emptyInbox, MAX_PENDING, SEEN_LIMIT } from "./inbox-rules.js";

/* The inbox is deliberately its own blob, separate from the sync payload.

   The app syncs by pushing its whole task list over the top of whatever was there.
   If suggestions lived inside that payload, anything arriving from ServiceM8 between
   a pull and a push would be wiped out by the push. Keeping them apart means the two
   can never tread on each other. */

export { emptyInbox, mergeSuggestions, resolveSuggestion, MAX_NEW_PER_RUN } from "./inbox-rules.js";

export function inboxStore() {
  return getStore({ name: "only-this-inbox", consistency: "strong" });
}

export async function readInbox(code) {
  if (!code) return emptyInbox();
  const data = await inboxStore().get(code, { type: "json" });
  if (!data) return emptyInbox();
  return {
    pending: Array.isArray(data.pending) ? data.pending : [],
    seen: Array.isArray(data.seen) ? data.seen : [],
    updatedAt: data.updatedAt || 0,
  };
}

export async function writeInbox(code, inbox) {
  await inboxStore().setJSON(code, {
    pending: (inbox.pending || []).slice(-MAX_PENDING),
    seen: (inbox.seen || []).slice(-SEEN_LIMIT),
    updatedAt: Date.now(),
  });
}
