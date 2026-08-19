// netlify/functions/feedback-list.mjs
//
// Reads the tester feedback reports out of the Blobs store and renders them as
// one page, behind the same ADMIN_SECRET as the stats page.
//
// ★ DELIBERATELY A NEW FILE, not an edit to stats.mjs. The stats page works and
//   is the thing Alex relies on; adding a second endpoint cannot break it, and
//   if this one throws, nothing else is affected.
//
// ★ IT ASSUMES ALMOST NOTHING ABOUT THE RECORD SHAPE. The fields it knows about
//   are printed as a tidy row; anything else in the record is printed verbatim
//   underneath. That way a field added to the app later still shows up here
//   instead of being silently dropped.
//
//   URL:  /api/feedback-list?secret=...
//         /api/feedback-list?secret=...&format=json     (raw, for keeping a copy)

import { getStore } from "@netlify/blobs";

const STORE = "acidbase-feedback";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Same length-independent comparison the other admin endpoint uses: a plain
// !== leaks how much of the secret was right through response timing.
function secretOk(given, expected) {
  if (!expected) return false;
  const a = String(given || ""), b = String(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const RATING_LABEL = {
  useful: "Useful as it is",
  awkward: "Useful but awkward",
  wrong: "It got something wrong",
};

function when(rec, key) {
  const t = rec.at || rec.ts || rec.time || rec.createdAt;
  const d = t ? new Date(typeof t === "number" ? t : Date.parse(t)) : null;
  if (d && !isNaN(d.getTime())) return d.toISOString().replace("T", " ").slice(0, 16);
  // The key usually carries the timestamp when the record itself doesn't.
  const m = String(key).match(/(\d{10,13})/);
  if (m) {
    const d2 = new Date(Number(m[1].length === 10 ? m[1] * 1000 : m[1]));
    if (!isNaN(d2.getTime())) return d2.toISOString().replace("T", " ").slice(0, 16);
  }
  return "—";
}

// Fields printed in the header row; everything else falls through to the dump.
const KNOWN = new Set([
  "at", "ts", "time", "createdAt", "rating", "text", "comment", "message",
  "version", "appVersion", "device", "deviceCode", "source", "entry", "entryMethod",
  "scanMode", "email", "name",
]);

export default async (request) => {
  const url = new URL(request.url);
  if (!secretOk(url.searchParams.get("secret"), process.env.ADMIN_SECRET)) {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }

  let records = [];
  try {
    const store = getStore(STORE);
    const listed = await store.list();
    const keys = (listed && listed.blobs ? listed.blobs : []).map((b) => b.key);
    for (const key of keys) {
      let rec = null;
      try { rec = await store.get(key, { type: "json" }); } catch {}
      if (rec == null) { try { rec = { text: await store.get(key) }; } catch {} }
      if (rec && typeof rec === "object") records.push({ key, rec });
    }
  } catch (e) {
    return new Response("Couldn't read the feedback store: " + esc(e && e.message), {
      status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Newest first — the report that arrived while you were reading matters most.
  records.sort((a, b) => String(when(b.rec, b.key)).localeCompare(String(when(a.rec, a.key))));

  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify(records, null, 2), {
      status: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const withText = records.filter(({ rec }) => (rec.text || rec.comment || rec.message || "").trim()).length;
  const counts = {};
  for (const { rec } of records) {
    const r = rec.rating || "(no rating)";
    counts[r] = (counts[r] || 0) + 1;
  }

  const rows = records.map(({ key, rec }) => {
    const text = (rec.text || rec.comment || rec.message || "").trim();
    const extra = Object.keys(rec)
      .filter((k) => !KNOWN.has(k))
      .map((k) => `${k}: ${JSON.stringify(rec[k])}`)
      .join("\n");
    const dev = rec.device || rec.deviceCode || "";
    const ver = rec.version || rec.appVersion || "";
    const entry = rec.entry || rec.entryMethod || "";
    return `
      <div class="rep">
        <div class="hdr">
          <span class="date">${esc(when(rec, key))}</span>
          ${rec.rating ? `<span class="pill r-${esc(rec.rating)}">${esc(RATING_LABEL[rec.rating] || rec.rating)}</span>` : ""}
          ${ver ? `<span class="pill">${esc(ver)}</span>` : ""}
          ${rec.source ? `<span class="pill">${esc(rec.source)}</span>` : ""}
          ${entry ? `<span class="pill">${esc(entry)}</span>` : ""}
          ${rec.scanMode ? `<span class="pill">${esc(rec.scanMode)}</span>` : ""}
          ${dev ? `<span class="dev">device ${esc(dev)}</span>` : ""}
        </div>
        ${text ? `<div class="text">${esc(text)}</div>` : `<div class="notext">(no text — rating only)</div>`}
        ${rec.email || rec.name ? `<div class="who">${esc(rec.name || "")} ${esc(rec.email || "")}</div>` : ""}
        ${extra ? `<details><summary>everything else in this record</summary><pre>${esc(extra)}</pre></details>` : ""}
        <div class="key">${esc(key)}</div>
      </div>`;
  }).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Acid-Base Scout — tester feedback</title>
<style>
  :root{--ink:#0f2a35;--muted:#5b7683;--teal:#137a8b;--line:#d7e3e8;--bg:#f3f7f8}
  *{box-sizing:border-box}
  body{margin:0;padding:18px;background:var(--bg);color:var(--ink);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:14px}
  .tot{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px}
  .tot b{font-size:22px}
  .tot span{color:var(--muted);font-size:13px;margin-left:8px}
  .rep{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}
  .hdr{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}
  .date{font-weight:700}
  .pill{font-size:12px;padding:2px 8px;border-radius:999px;background:#e8f1f4;color:var(--teal);white-space:nowrap}
  .pill.r-wrong{background:#fdeaea;color:#a12626}
  .pill.r-awkward{background:#fdf3e2;color:#8a5a06}
  .pill.r-useful{background:#e7f6ec;color:#166b38}
  .dev{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
  .text{white-space:pre-wrap;border-left:3px solid var(--teal);padding:2px 0 2px 10px}
  .notext{color:var(--muted);font-style:italic}
  .who{margin-top:6px;font-size:13px;color:var(--muted)}
  .key{margin-top:8px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9db0b8}
  details{margin-top:8px}
  summary{cursor:pointer;font-size:13px;color:var(--teal)}
  pre{white-space:pre-wrap;font-size:12px;background:#f7fafb;border-radius:8px;padding:8px;margin:6px 0 0}
  .note{margin-top:18px;font-size:12.5px;color:var(--muted);line-height:1.55}
  a{color:var(--teal)}
</style></head><body>
  <h1>Tester feedback</h1>
  <div class="sub">Acid-Base Scout · store <code>${esc(STORE)}</code> · newest first</div>
  <div class="tot">
    <b>${records.length}</b><span>report(s) · ${withText} with written text</span>
    <div class="sub" style="margin:8px 0 0">${Object.entries(counts).map(([k, v]) => `${esc(RATING_LABEL[k] || k)}: ${v}`).join(" · ") || "no ratings yet"}</div>
  </div>
  ${rows || `<div class="rep"><div class="notext">Nothing has come in yet.</div></div>`}
  <div class="note">
    Reports carry the app version, how the values were entered and the device code — the code is what ties a
    report to a doctor through your own list. They are not supposed to contain anything about a patient; the app
    warns against it at the text box. <b>If something identifying does turn up here, delete that record from the
    Blobs store rather than leaving it.</b>
    <br><br>A raw copy: <a href="?secret=${esc(url.searchParams.get("secret"))}&amp;format=json">JSON</a>.
  </div>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
};
