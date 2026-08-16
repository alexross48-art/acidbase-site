// POST /api/signup  { name, email, campaign }
// Self-service invite codes with per-campaign quotas.
// - One email = one code, forever: signing up again with the same email
//   RETURNS THE SAME CODE and does not touch the quota (his "forgot the code" case).
// - Campaigns and their quotas live in the env var CAMPAIGNS, e.g.
//   "FORUM2026:50,HADASSAH:30" — raising a quota is an env edit + redeploy.
// - Minted codes are stored in Blobs (code:<CODE>) and honored by key.mjs
//   alongside the hand-out codes in INVITE_CODES.
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const normCamp = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });

  const CAMPAIGNS = {};
  for (const part of (process.env.CAMPAIGNS || "").split(",")) {
    const [c, n] = part.split(":");
    if (c && n && parseInt(n, 10) > 0) CAMPAIGNS[normCamp(c)] = parseInt(n, 10);
  }
  if (!Object.keys(CAMPAIGNS).length)
    return new Response(JSON.stringify({ error: "Signup is not open yet." }), { status: 500, headers: cors });

  let body = {};
  try { body = await req.json(); } catch {}
  const name = (body.name || "").trim().slice(0, 120);
  const email = (body.email || "").trim().toLowerCase().slice(0, 200);
  const campaign = normCamp(body.campaign);

  const store = getStore("acidbase-trial");
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  const hourKey = `su:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const tries = parseInt((await store.get(hourKey)) || "0", 10);
  if (tries >= 10)
    return new Response(JSON.stringify({ error: "Too many attempts — try again in an hour." }), { status: 429, headers: cors });
  await store.set(hourKey, String(tries + 1));

  if (name.length < 2)
    return new Response(JSON.stringify({ error: "Please enter your name." }), { status: 400, headers: cors });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return new Response(JSON.stringify({ error: "That email doesn't look right." }), { status: 400, headers: cors });
  if (!campaign || !(campaign in CAMPAIGNS))
    return new Response(JSON.stringify({ error: "Unknown event code — check the word you were given at the talk." }), { status: 400, headers: cors });

  // the same email always gets the same code back — quota untouched
  const prevRaw = await store.get(`signup:${email}`);
  if (prevRaw) {
    const prev = JSON.parse(prevRaw);
    return new Response(JSON.stringify({ code: prev.code, again: true }), { status: 200, headers: cors });
  }

  const used = parseInt((await store.get(`quota:${campaign}`)) || "0", 10);
  if (used >= CAMPAIGNS[campaign])
    return new Response(JSON.stringify({ error: "All spots for this event are taken — write to the organiser to open more." }), { status: 403, headers: cors });

  let code = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    let c = "TRIAL-";
    const buf = new Uint8Array(5); crypto.getRandomValues(buf);
    for (const b of buf) c += ALPHABET[b % 32];
    if (!(await store.get(`code:${c}`))) { code = c; break; }
  }
  if (!code)
    return new Response(JSON.stringify({ error: "Please try again." }), { status: 500, headers: cors });

  const at = new Date().toISOString();
  await store.set(`code:${code}`, JSON.stringify({ email, campaign, at }));
  await store.set(`signup:${email}`, JSON.stringify({ name, code, campaign, at }));
  await store.set(`quota:${campaign}`, String(used + 1));
  return new Response(JSON.stringify({ code }), { status: 200, headers: cors });
};
