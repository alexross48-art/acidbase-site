// POST /api/usage — the phone's own counter, reported after each analysis.
// Also the only place the app learns that a newer build exists.
import { getStore } from "@netlify/blobs";

/* ★★ CORS, AND WHY ITS ABSENCE LOOKED LIKE NOTHING AT ALL.
   The app is web code inside a native shell, so its requests carry an origin
   the browser treats as foreign. A POST with a JSON content type therefore
   gets a preflight OPTIONS first — and the previous version of this file
   answered that with 405 "POST only" and no CORS headers, so the preflight
   failed and THE REQUEST WAS NEVER SENT. No log showed anything, the app
   showed no error (the tick is fire-and-forget by design), and curl worked
   perfectly, because curl does not preflight. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const clean = (s, max) => String(s == null ? "" : s).replace(/[^A-Za-z0-9._-]/g, "").slice(0, max);

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { "Content-Type": "application/json", ...CORS } });

  let body = {};
  try { body = await req.json(); } catch {}

  const device  = clean(body.device, 24);
  const install = clean(body.install, 24);
  const version = clean(body.version, 24);
  const total   = Number(body.total);

  if (!device || !Number.isFinite(total) || total < 0)
    return new Response(JSON.stringify({ error: "bad request" }),
      { status: 400, headers: { "Content-Type": "application/json", ...CORS } });

  const key = install ? `usage:${device}:${install}` : `usage:${device}`;

  let wrote = false, err = null, prev = null, kept = total;
  try {
    const store = getStore("acidbase-trial");
    try { const raw = await store.get(key); if (raw) prev = JSON.parse(raw); } catch {}
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

  return new Response(JSON.stringify({
    ok: true, wrote, err, key, stored: kept,
    latest: process.env.LATEST_VERSION || null,
    notes:  process.env.LATEST_NOTES   || null,
    url:    process.env.LATEST_URL     || null,
  }), { headers: { "Content-Type": "application/json", ...CORS } });
};
