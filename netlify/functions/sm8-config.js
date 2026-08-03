import { readConfig, writeConfig, cleanConfig, publicView, emptyConfig } from "../lib/sm8-config.js";
import { pollOne, whyNotReady } from "../lib/sm8-run.js";
import { sm8Get } from "../lib/servicem8.js";

/* Setting up ServiceM8 from inside the app.

   GET  /api/sm8?code=X                 -> status. Never includes the API key.
   POST /api/sm8 {code, ...settings}    -> save. An empty apiKey leaves the stored one be.
   POST /api/sm8 {code, action:"test"}  -> try the key and report what came back
   POST /api/sm8 {code, action:"run"}   -> check ServiceM8 now rather than on the quarter hour
   POST /api/sm8 {code, action:"forget"}-> delete the key and settings

   The key only ever travels inwards. There is no route that returns it. */

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
    return json(publicView(await readConfig(code)));
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

  const existing = await readConfig(code);

  if (body.action === "forget") {
    await writeConfig(code, emptyConfig());
    return json({ ok: true, ...publicView(emptyConfig()) });
  }

  /* Check the key actually works, and confirm who we think you are. Worth having:
     the two things most likely to be wrong are a mistyped key and the wrong staff
     UUID, and both are invisible until something silently fails to arrive. */
  if (body.action === "test") {
    const key = (typeof body.apiKey === "string" && body.apiKey.trim()) || existing.apiKey;
    if (!key) return json({ ok: false, error: "No API key saved yet." });
    try {
      const staff = await sm8Get("staff.json", key);
      const list = Array.isArray(staff) ? staff : [];
      const wanted = (body.staffUuid || existing.staffUuid || "").trim();
      const me = list.find((s) => s.uuid === wanted);
      return json({
        ok: true,
        staffCount: list.length,
        matched: me ? `${me.first || ""} ${me.last || ""}`.trim() || me.email || "found" : null,
        // Enough to pick yourself out without asking you to go hunting in an API.
        staff: list.slice(0, 40).map((s) => ({
          uuid: s.uuid,
          name: `${s.first || ""} ${s.last || ""}`.trim() || s.email || s.uuid,
        })),
      });
    } catch (e) {
      const status = e && e.status;
      return json({
        ok: false,
        error: status === 401 || status === 403
          ? "ServiceM8 refused that key. Check you copied all of it."
          : "Could not reach ServiceM8" + (status ? ` (${status})` : "") + ".",
      });
    }
  }

  /* Check now. The schedule is every fifteen minutes, which is fine once it is working
     and unbearable while you are still finding out whether it does. This runs the very
     same code the schedule runs, so a pass here means a pass there. */
  if (body.action === "run") {
    const blocked = whyNotReady(existing);
    if (blocked) return json({ ok: false, error: blocked });
    try {
      const res = await pollOne(code, existing);
      return json({
        ok: true,
        found: res.found,
        added: res.added,
        waiting: res.waiting,
        held: res.held,
        problems: res.problems,
        report: res.report,
        ...publicView(await readConfig(code)),
      });
    } catch (e) {
      return json({ ok: false, error: "The check failed: " + (e.message || "unknown error") });
    }
  }

  const next = cleanConfig(body, existing);
  await writeConfig(code, next);
  return json({ ok: true, ...publicView(next) });
};

export const config = { path: "/api/sm8" };
