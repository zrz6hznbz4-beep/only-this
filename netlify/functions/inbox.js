import { readInbox, writeInbox, resolveSuggestion } from "../lib/inbox-store.js";

/* What the app talks to.

   GET  /api/inbox?code=ABC123          -> { pending: [...] }
   POST /api/inbox {code, id}           -> take one off the queue (added or dismissed —
                                           the app has already done whatever it is doing
                                           with it locally)

   Keyed by sync code, the same way /api/sync is. */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function cleanCode(raw) {
  const code = (raw || "").toString().trim().toUpperCase();
  if (!code || code.length < 4 || code.length > 40) return null;
  return code;
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const code = cleanCode(url.searchParams.get("code"));
    if (!code) return json({ error: "Missing or invalid sync code" }, 400);
    const inbox = await readInbox(code);
    return json({ pending: inbox.pending, updatedAt: inbox.updatedAt });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const code = cleanCode(body.code);
  if (!code) return json({ error: "Missing or invalid sync code" }, 400);

  // Clearing the lot — useful if the queue ever gets away from you.
  if (body.action === "clear") {
    const inbox = await readInbox(code);
    await writeInbox(code, { pending: [], seen: inbox.seen });
    return json({ ok: true, pending: [] });
  }

  if (!body.id) return json({ error: "Missing suggestion id" }, 400);

  const inbox = await readInbox(code);
  const next = resolveSuggestion(inbox, body.id);
  await writeInbox(code, next);
  return json({ ok: true, removed: next.removed, pending: next.pending });
};

export const config = { path: "/api/inbox" };
