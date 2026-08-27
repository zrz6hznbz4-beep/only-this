import { getStore } from "@netlify/blobs";
import { mergePayload } from "../lib/sync-merge.js";

/* The shared list.

   GET  /api/sync?code=X   -> the list as it stands
   POST /api/sync?code=X   -> merge what this device has into it

   A POST used to replace the stored list outright. That is safe enough for one person
   with two devices, and quietly destructive the moment two people share a list: the
   one who saves second erases the other's afternoon. So the server now merges, task by
   task, and the merge lives in lib/sync-merge.js where it can be tested. */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (!code || code.length < 4 || code.length > 40) {
    return json({ error: "Missing or invalid sync code" }, 400);
  }

  const store = getStore({ name: "only-this-sync", consistency: "strong" });

  if (req.method === "GET") {
    const data = await store.get(code, { type: "json" });
    return new Response(JSON.stringify(data || null), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const stored = await store.get(code, { type: "json" });
  const merged = mergePayload(stored, body, Date.now());
  await store.setJSON(code, merged);

  /* Hand the merged list straight back. The device that pushed can then hold exactly
     what the server holds, rather than believing its own version is the truth and
     finding out otherwise on the next poll. */
  return json({ ok: true, data: merged });
};

export const config = { path: "/api/sync" };
