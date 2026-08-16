// GET /api/stats?secret=...  — the organiser's page: per-campaign counts and
// the full roster (name, email, code, redeemed-on-a-phone or not, date).
// Renders plain HTML. Protected by the ADMIN_SECRET env var.
import { getStore } from "@netlify/blobs";

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async (req) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || "";
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET)
    return new Response("Not authorized.", { status: 403, headers: { "Content-Type": "text/plain" } });

  const store = getStore("acidbase-trial");
  const rows = [];
  let cursor;
  do {
    const page = await store.list({ prefix: "signup:", cursor });
    for (const b of page.blobs) {
      const raw = await store.get(b.key);
      if (!raw) continue;
      const d = JSON.parse(raw);
      d.email = b.key.slice("signup:".length);
      d.bound = !!(await store.get(`bind:${d.code}`));
      rows.push(d);
    }
    cursor = page.cursor;
  } while (cursor);
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));

  const perCamp = {};
  for (const r of rows) {
    perCamp[r.campaign] = perCamp[r.campaign] || { signed: 0, bound: 0 };
    perCamp[r.campaign].signed++;
    if (r.bound) perCamp[r.campaign].bound++;
  }
  // feedback count
  let fb = 0; cursor = undefined;
  const fstore = getStore("acidbase-feedback");
  do {
    const page = await fstore.list({ cursor });
    fb += page.blobs.length; cursor = page.cursor;
  } while (cursor);

  const campRows = Object.entries(perCamp).map(([c, v]) =>
    `<tr><td>${esc(c)}</td><td>${v.signed}</td><td>${v.bound}</td></tr>`).join("");
  const listRows = rows.map((r) =>
    `<tr><td>${esc(r.at.slice(0, 16).replace("T", " "))}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td><code>${esc(r.code)}</code></td><td>${esc(r.campaign)}</td><td>${r.bound ? "✓ on a phone" : "—"}</td></tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Acid-Base Scout — trial stats</title>
<style>body{font:15px/1.5 system-ui;background:#0B1F2A;color:#EAF2F4;padding:24px;max-width:960px;margin:0 auto}
h1{font-size:22px}h2{font-size:17px;color:#43BCD2;margin-top:26px}
table{border-collapse:collapse;width:100%;margin-top:10px}
td,th{border:1px solid #1E4B5E;padding:7px 10px;text-align:left;font-size:14px}
th{background:#102A38}code{color:#9FE0EC}</style></head><body>
<h1>Acid-Base Scout — closed trial</h1>
<p>Signed up: <b>${rows.length}</b> · Activated on a phone: <b>${rows.filter((r) => r.bound).length}</b> · Feedback reports: <b>${fb}</b></p>
<h2>By event</h2>
<table><tr><th>Event</th><th>Signed up</th><th>Activated</th></tr>${campRows || "<tr><td colspan=3>—</td></tr>"}</table>
<h2>Everyone</h2>
<table><tr><th>Date</th><th>Name</th><th>Email</th><th>Code</th><th>Event</th><th>Status</th></tr>${listRows || "<tr><td colspan=6>—</td></tr>"}</table>
</body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
};
