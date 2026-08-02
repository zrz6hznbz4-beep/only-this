import { getStore } from "@netlify/blobs";
import webpush from "web-push";

/* Shared plumbing for the push endpoints. Lives outside netlify/functions so that
   Netlify does not try to deploy it as a function in its own right. */

export function subscriptionsStore() {
  return getStore({ name: "only-this-push", consistency: "strong" });
}

/* VAPID keys identify this server to the push services. Taken from environment
   variables if present, otherwise generated once and kept in the blob store —
   which means there are no keys to handle by hand. Set VAPID_PUBLIC_KEY and
   VAPID_PRIVATE_KEY in Netlify later if you would rather they lived there. */
export async function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const store = subscriptionsStore();
  const existing = await store.get("__vapid", { type: "json" });
  if (existing && existing.publicKey && existing.privateKey) return existing;

  const generated = webpush.generateVAPIDKeys();
  await store.setJSON("__vapid", generated);
  return generated;
}

// Endpoints are long URLs; hash them into something safe to use as a blob key.
export function keyForEndpoint(endpoint) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < endpoint.length; i++) {
    const c = endpoint.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return "sub_" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
