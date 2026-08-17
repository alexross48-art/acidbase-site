// POST /api/key  { deviceId: "ABCD-EFGH", invite: "TRIAL-XXXXX" }
// Derives the unlock key EXACTLY as the app does:
//   first 16 bytes of HMAC-SHA256(TRIAL_SECRET, "acidbase-scout|<deviceCode>"),
//   each byte % 32 onto ABCDEFGHJKLMNPQRSTUVWXYZ23456789, shown XXXX-XXXX-XXXX-XXXX.
// TRIAL_SECRET lives only in the Netlify env var — it never reaches the browser.
// One invite code binds to the FIRST device that redeems it; the same device may
// ask again (lost key), a different device is refused.
import { createHmac } from "node:crypto";
import { getStore } from "@netlify/blobs";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const norm = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

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

  const SECRET = process.env.TRIAL_SECRET;
  const CODES = (process.env.INVITE_CODES || "").split(",").map((c) => norm(c)).filter(Boolean);
  if (!SECRET || !CODES.length)
    return new Response(JSON.stringify({ error: "Server not configured yet." }), { status: 500, headers: cors });

  let body = {};
  try { body = await req.json(); } catch {}
  const device = norm(body.deviceId);
  const invite = norm(body.invite);

  // simple throttle: 12 failures per IP per hour
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  // strong consistency: a doctor redeems the code seconds after the signup form
  // minted it, so an eventual read may not see code:<CODE> yet and would answer
  // "invite code isn't recognised". Same for bind:<CODE> and the device check.
  const store = getStore({ name: "acidbase-trial", consistency: "strong" });
  const hourKey = `attempts:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const fails = parseInt((await store.get(hourKey)) || "0", 10);
  if (fails >= 12)
    return new Response(JSON.stringify({ error: "Too many attempts — try again in an hour." }), { status: 429, headers: cors });
  const fail = async (msg, status = 400) => {
    await store.set(hourKey, String(fails + 1));
    return new Response(JSON.stringify({ error: msg }), { status, headers: cors });
  };

  if (device.length !== 8) return fail("The Device ID is 8 characters, shown as ABCD-EFGH.");
  // a code is valid if it's in the hand-out list (INVITE_CODES) OR was minted
  // by the signup form (stored in Blobs as code:<CODE>)
  const dashed = invite.length === 10 ? invite.slice(0, 5) + "-" + invite.slice(5) : invite;
  const minted = await store.get(`code:${dashed}`);
  if (!CODES.includes(invite) && !minted) return fail("That invite code isn't recognised.");

  const bindKey = `bind:${minted ? dashed : invite}`;
  const boundTo = await store.get(bindKey);
  if (boundTo && boundTo !== device)
    return fail("This invite code was already used on a different phone.", 403);
  if (!boundTo) await store.set(bindKey, device);

  const h = createHmac("sha256", SECRET).update(`acidbase-scout|${device}`).digest();
  let flat = "";
  for (let i = 0; i < 16; i++) flat += ALPHABET[h[i] % 32];
  const key = flat.match(/.{1,4}/g).join("-");
  return new Response(JSON.stringify({ key }), { status: 200, headers: cors });
};
