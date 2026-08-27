// POST /api/usage — the phone's own counter, reported after each analysis.
// Also the only place the app learns that a newer build exists.
import { getStore } from "@netlify/blobs";

/* ★★ WHY THIS ADDS UP INSTEAD OF KEEPING A MAXIMUM.
   The phone sends its RUNNING TOTAL, never a delta: a lost send then costs
   nothing and a resend cannot double-count. Keeping the maximum made that
   safe — until the field showed the price. Alex's number sat at 37 through a
   day of real work. His phone's counter had restarted at some point (an
   app-data clear, a reinstall that was not "over the top"), so every tick
   since carried a number BELOW 37 and the maximum discarded all of them. The
   count freezes for good, silently, with nothing on either side looking broken.
   ★ The fix keeps what made max right: each INSTALLATION reports under its own
   key, the maximum is taken per installation, and stats.mjs adds the
   installations up. A restart opens a new bucket that accumulates instead of
   being swallowed.
   ★ Ticks written before v1.1.65 have no install id and live under the old key
   `usage:<device>`. They are left exactly where they are — the prefix sum in
   stats.mjs picks them up unchanged, so nothing already counted is lost. */

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
  const store = getStore("acidbase-trial");

  let prev = null;
  try { const raw = await store.get(key); if (raw) prev = JSON.parse(raw); } catch {}
  // Max WITHIN one installation — the original protection, in the only scope
  // where it is always true.
  const kept = Math.max(total, prev && Number.isFinite(prev.total) ? prev.total : 0);

  try {
    await store.set(key, JSON.stringify({
      total: kept,
      device,
      version: version || (prev && prev.version) || "",
      at: new Date().toISOString(),
      scan: body.scan && typeof body.scan === "object" ? body.scan : (prev ? prev.scan : null),
    }));
  } catch {}

  /* The reply tells the app whether a newer build exists. Set these three in
     Netlify → Environment variables. ★ Raise LATEST_VERSION only AFTER the new
     APK is actually at LATEST_URL, or a doctor downloads what he already has
     and concludes the update is broken. */
  return new Response(JSON.stringify({
    ok: true,
    latest: process.env.LATEST_VERSION || null,
    notes:  process.env.LATEST_NOTES   || null,
    url:    process.env.LATEST_URL     || null,
  }), { headers: { "Content-Type": "application/json" } });
};
