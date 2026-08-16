// POST /api/feedback — takes feedback from the app (offline queue) and from the
// site form. Stores the raw JSON in Netlify Blobs under a timestamped id.
// The app never sends patient data; the site form warns not to include any.
import { getStore } from "@netlify/blobs";

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
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
};
