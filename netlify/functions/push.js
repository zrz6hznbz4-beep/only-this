import { defaultPrefs, TYPE_IDS } from "../lib/notification-types.js";
import { subscriptionsStore, keyForEndpoint, getVapidKeys } from "../lib/push-store.js";


/* Subscription registry for push notifications.

   GET    /api/push                            -> { publicKey }
   POST   /api/push                            -> save a subscription and its preferences
   POST   /api/push {action:"unsubscribe"}     -> forget a subscription
   POST   /api/push {action:"replace"}         -> the browser rotated our endpoint */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function cleanPrefs(input) {
  const base = defaultPrefs();
  if (!input || typeof input !== "object") return base;
  const lists = ["work", "personal", "both"].includes(input.lists) ? input.lists : base.lists;
  const types = { ...base.types };
  if (input.types && typeof input.types === "object") {
    for (const id of TYPE_IDS) {
      if (typeof input.types[id] === "boolean") types[id] = input.types[id];
    }
  }
  return { lists, types };
}

export default async (req) => {
  const store = subscriptionsStore();

  if (req.method === "GET") {
    const { publicKey } = await getVapidKeys();
    return json({ publicKey });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action || "save";

  if (action === "unsubscribe") {
    if (!body.endpoint) return json({ error: "Missing endpoint" }, 400);
    await store.delete(keyForEndpoint(body.endpoint));
    return json({ ok: true });
  }

  if (action === "replace") {
    if (!body.subscription || !body.subscription.endpoint) return json({ error: "Missing subscription" }, 400);
    let carried = null;
    if (body.oldEndpoint) {
      const oldKey = keyForEndpoint(body.oldEndpoint);
      carried = await store.get(oldKey, { type: "json" });
      await store.delete(oldKey);
    }
    const record = {
      ...(carried || { prefs: defaultPrefs(), code: null, tz: "UTC", sent: {} }),
      subscription: body.subscription,
      updatedAt: Date.now(),
    };
    await store.setJSON(keyForEndpoint(body.subscription.endpoint), record);
    return json({ ok: true });
  }

  // Default: save or update a subscription.
  const sub = body.subscription;
  if (!sub || !sub.endpoint) return json({ error: "Missing subscription" }, 400);

  const key = keyForEndpoint(sub.endpoint);
  const existing = (await store.get(key, { type: "json" })) || {};

  const record = {
    subscription: sub,
    // The sync code tells the sender which task list belongs to this device.
    code: (body.code || existing.code || "").toString().trim().toUpperCase() || null,
    tz: body.tz || existing.tz || "UTC",
    prefs: cleanPrefs(body.prefs || existing.prefs),
    sent: existing.sent || {},
    lastSnoozeCheck: existing.lastSnoozeCheck || Date.now(),
    updatedAt: Date.now(),
  };

  await store.setJSON(key, record);
  return json({ ok: true, prefs: record.prefs });
};

export const config = { path: "/api/push" };
