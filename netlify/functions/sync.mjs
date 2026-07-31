import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (!code || code.length < 4 || code.length > 40) {
    return new Response(JSON.stringify({ error: "Missing or invalid sync code" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const store = getStore({ name: "only-this-sync", consistency: "strong" });

  if (req.method === "GET") {
    const data = await store.get(code, { type: "json" });
    return new Response(JSON.stringify(data || null), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    await store.setJSON(code, body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/sync" };
