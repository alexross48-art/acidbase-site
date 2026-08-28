// POST /api/usage — the phone's own counter, reported after each analysis.
// Also the only place the app learns that a newer build exists.
import { getStore } from "@netlify/blobs";

/* ★★ WHY THIS ADDS UP INSTEAD OF KEEPING A MAXIMUM.
   The phone sends its RUNNING TOTAL, never a delta: a lost send costs nothing
   and a resend cannot double-count. Keeping the maximum made that safe — until
   the field showed the price. Alex's number sat at 37 through a day of real
   work: his phone's counter had restarted, so every tick since carried a
   number BELOW 37 and the maximum discarded all of them.
   ★ Each INSTALLATION now reports under its own key, the maximum is taken per
   installation, and stats.mjs adds the installations up.
   ★ Ticks written before v1.1.65 have no install id and live under the old key
   `usage:<device>`; the prefix sum in stats.mjs picks them up unchanged.

   ★★ AND THE WRITE NO LONGER FAILS IN SILENCE. The first version of this file
   wrapped the write in `try { ... } catch {}`, so a storage failure looked
   exactly like success: the function still answered {ok:true} and the count
   simply stopped moving. That is precisely the state Alex spent an evening
   trying to diagnose. The outcome is now reported in the reply — `wrote` and,
   when it fails, `err`. The phone ignores both, as it always did; they exist
   so a person with curl can see the truth in one call. */

const clean = (s, max) => String(s == null ? "" : s).replace(/[^A-Za-z0-9._-]/g, "").slice(0, max);

export default async (req) => {
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { "Content-Type": "application/json" } });

  let body = {};
  try { body = await req.json(); } catch {}

  const device  = clean(body.device, 24);
  const install = clean(body.install, 24);
  const version = clean(body.version, 24);
  const total   = Number(body.total);

  if (!device || !Number.isFinite(total) || total < 0)
    return new Response(JSON.stringify({ error: "bad request" }),
      { status: 400, headers: { "Content-Type": "application/json" } });

  // No install id means a build older than 1.1.65 — keep writing where it
  // always wrote, so its history stays intact.
  const key = install ? `usage:${device}:${install}` : `usage:${device}`;

  let wrote = false, err = null, prev = null, kept = total;
  try {
    const store = getStore("acidbase-trial");
    try { const raw = await store.get(key); if (raw) prev = JSON.parse(raw); } catch {}
    // Max WITHIN one installation — the original protection, in the only scope
    // where it is always true.
    kept = Math.max(total, prev && Number.isFinite(prev.total) ? prev.total : 0);
    await store.set(key, JSON.stringify({
      total: kept,
      device,
      version: version || (prev && prev.version) || "",
      at: new Date().toISOString(),
      scan: body.scan && typeof body.scan === "object" ? body.scan : (prev ? prev.scan : null),
    }));
    wrote = true;
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 300);
  }

  /* The reply tells the app whether a newer build exists. Set these three in
     Netlify → Environment variables. ★ Raise LATEST_VERSION only AFTER the new
     APK is actually at LATEST_URL, or a doctor downloads what he already has
     and concludes the update is broken. */
  return new Response(JSON.stringify({
    ok: true,
    wrote,                       // ← false means the count did NOT move
    err,                         // ← why, when it did not
    key,                         // ← where it tried to write
    stored: kept,
    latest: process.env.LATEST_VERSION || null,
    notes:  process.env.LATEST_NOTES   || null,
    url:    process.env.LATEST_URL     || null,
  }), { headers: { "Content-Type": "application/json" } });
};
