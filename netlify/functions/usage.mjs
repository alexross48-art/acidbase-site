// POST /api/usage  { device: "ABCD-EFGH", version: "1.1.57-beta", total: 42 }
// The app sends ONE number after each completed analysis: the running total
// of analyses on that device. Newest total wins — it only ever grows, and a
// device that was offline catches up with a single tick. Disclosed in the
// app's consent screen and privacy policy; no case data ever rides along.
import { getStore } from "@netlify/blobs";

const norm = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

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
  try { body = await req.json(); } catch {}
  const device = norm(body.device);
  const total = parseInt(body.total, 10);
  const version = String(body.version || "").slice(0, 40);
  if (device.length !== 8 || !Number.isFinite(total) || total < 0 || total > 1000000)
    return new Response(JSON.stringify({ error: "Bad tick." }), { status: 400, headers: cors });

  // same store and the same undashed device format key.mjs uses for bind:,
  // so the stats page can join a signup's code to its analyses count
  const store = getStore({ name: "acidbase-trial", consistency: "strong" });
  const key = `usage:${device}`;
  const prevRaw = await store.get(key);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const at = new Date().toISOString();
  const next = {
    total: Math.max(total, prev ? prev.total || 0 : 0),
    version,
    at,
    first: prev && prev.first ? prev.first : at,
  };
  await store.set(key, JSON.stringify(next));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
};
