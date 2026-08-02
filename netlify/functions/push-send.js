import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { subscriptionsStore, getVapidKeys } from "../lib/push-store.js";
import { decide } from "../lib/notification-types.js";

/* Scheduled sender. Runs every 15 minutes and asks, for each subscribed device:
   what time is it where you are, which notification types have you switched on,
   and is there anything actually worth saying?

   Running on a short cron rather than at fixed hours is what makes timezones work —
   7:30am happens at a different UTC moment for everyone. The decision itself lives
   in notification-types.js so it can be tested without any of this plumbing. */

export default async () => {
  const store = subscriptionsStore();
  const syncStore = getStore({ name: "only-this-sync", consistency: "strong" });

  const { publicKey, privateKey } = await getVapidKeys();
  webpush.setVapidDetails("mailto:notifications@only-this.app", publicKey, privateKey);

  const listing = await store.list();
  const now = new Date();
  const payloadCache = new Map();
  let sentCount = 0, pruned = 0;

  for (const entry of listing.blobs || []) {
    if (entry.key === "__vapid") continue;

    const record = await store.get(entry.key, { type: "json" });
    if (!record || !record.subscription) continue;

    // Without a sync code the server has no idea what is on your list.
    if (!record.code) continue;

    if (!payloadCache.has(record.code)) {
      payloadCache.set(record.code, await syncStore.get(record.code, { type: "json" }));
    }
    const payload = payloadCache.get(record.code);
    if (!payload) continue;

    const { messages, sent, checkedAt } = decide(record, now, payload);

    let dead = false;
    for (const message of messages) {
      try {
        await webpush.sendNotification(
          record.subscription,
          JSON.stringify({ title: message.title, body: message.body, tag: message.id, url: "/" })
        );
        sentCount++;
      } catch (err) {
        // 404/410 mean the browser threw this subscription away.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) dead = true;
      }
    }

    if (dead) {
      await store.delete(entry.key);
      pruned++;
      continue;
    }

    await store.setJSON(entry.key, { ...record, sent, lastSnoozeCheck: checkedAt });
  }

  return new Response(JSON.stringify({ ok: true, sent: sentCount, pruned }), {
    headers: { "content-type": "application/json" },
  });
};

export const config = { schedule: "*/15 * * * *" };
