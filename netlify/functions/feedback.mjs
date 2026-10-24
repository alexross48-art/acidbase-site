// POST /api/feedback — takes feedback from the app (offline queue) and from the
// site form. Stores the raw JSON in Netlify Blobs under a timestamped id, then
// mails a copy to the app's address (acidbasescout@gmail.com) when a Resend key
// is set. The stored copy is the record; the mail is a convenience, so a mail
// that fails never fails the request — the app would otherwise keep re-sending.
// The app never sends patient data; the site form warns not to include any.
import { getStore } from "@netlify/blobs";

const MAIL_TO = () => process.env.FEEDBACK_EMAIL_TO || "acidbasescout@gmail.com";
// onboarding@resend.dev needs no domain of our own, but Resend then delivers only
// to the address the Resend account was opened with — so open it with the app's address.
const MAIL_FROM = () => process.env.FEEDBACK_EMAIL_FROM || "Acid-Base Scout <onboarding@resend.dev>";

const RATING = {
  useful: "Useful as it is",
  mixed: "Useful, but awkward",
  wrong: "It got something wrong",
};

// Build the letter. Plain text only: whatever the sender typed is shown, never run.
export function feedbackMail(body, id) {
  const site = body && body.source === "site";
  const note = String((site ? body.text : body.note) || "").trim();
  const lines = [];
  let subject;
  if (site) {
    subject = "Acid-Base Scout — feedback from the site";
    lines.push(note || "(no text)");
    if (body.email) lines.push("", "Reply to: " + String(body.email).slice(0, 200));
  } else {
    const rating = RATING[body.rating] || String(body.rating || "no rating");
    subject = `Acid-Base Scout — ${rating}` + (body.version ? ` (v${String(body.version).slice(0, 20)})` : "");
    lines.push("Rating: " + rating, "", note || "(no comment)", "");
    if (body.version) lines.push("App version: " + body.version);
    if (body.device) lines.push("Device ID: " + body.device);
    const c = body.context || {};
    if (c.casesCompleted != null) lines.push("Cases done on this phone: " + c.casesCompleted);
    if (c.entry) lines.push("Values entered by: " + c.entry + (c.scanMode ? ` (${c.scanMode})` : ""));
  }
  lines.push("", "Sent: " + (body.at || new Date().toISOString()), "Stored as: " + id);
  const replyTo = site && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(body.email || "").trim())
    ? String(body.email).trim() : undefined;
  return { subject, text: lines.join("\n"), replyTo };
}

async function mailCopy(body, id) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return "skipped: no RESEND_API_KEY";
  const m = feedbackMail(body, id);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM(), to: [MAIL_TO()], subject: m.subject, text: m.text,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: ctl.signal,
    });
    if (r.ok) return "sent";
    return `refused ${r.status}: ${(await r.text()).slice(0, 300)}`;
  } catch (e) {
    return "failed: " + String((e && e.message) || e).slice(0, 200);
  } finally { clearTimeout(t); }
}

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
  let body = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Send JSON." }), { status: 400, headers: cors });
  }
  const text = JSON.stringify(body);
  if (text.length > 20000)
    return new Response(JSON.stringify({ error: "Too large." }), { status: 413, headers: cors });
  const store = getStore("acidbase-feedback");
  const id = `${new Date().toISOString()}_${Math.random().toString(36).slice(2, 8)}`;
  await store.set(id, text);
  const mail = await mailCopy(body, id);
  console.log(`feedback ${id}: mail ${mail}`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
};
