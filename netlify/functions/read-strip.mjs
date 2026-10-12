// POST /api/read-strip — Cloud check (test): reads ONE already-redacted strip
// of a blood-gas screen and returns parameter -> value.
//
// The phone has already cut the photo down to the table's own rows (names +
// values), blacked out every word with six or more digits, re-read the strip
// and refused to send if one survived. This function adds a check of its own,
// holds the Anthropic key so it never ships inside the app, accepts only
// licensed devices, caps the daily spend, and keeps nothing but counts.
//
// Netlify env:
//   ANTHROPIC_API_KEY    the key (billing goes to Alex's Anthropic account)
//   TRIAL_SECRET         already set — the same secret /api/key uses; a request
//                        must carry the device's own unlock key
//   CLOUD_READ_MODEL     default "claude-haiku-5-5"
//   CLOUD_READ_ESCALATE  default "claude-sonnet-5-5" — one retry when the cheap
//                        read fails the screen's own arithmetic; "" turns it off
//   CLOUD_DAILY_CAP      max reads per UTC day across all devices (default 500)
//   CLOUD_DEVICE_CAP     max reads per device per day (default 60)
import { createHmac } from "node:crypto";
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

// the app's FIELD keys, plus four printed values used only for the checksums
export const KEYS = ["pH", "pCO2", "pO2", "HCO3", "tCO2", "BE", "sO2", "Na", "K", "Cl",
  "calcium", "lactate", "glucose", "AG", "tHb", "Hct", "metHb", "coHb", "albumin", "creatinine"];

// USD per million tokens (input, output) — platform.claude.com pricing, Oct 2026
const PRICES = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "claude-haiku-4-5": [1, 5],
};

const PROMPT = `This image is a cropped strip of a hospital blood-gas result screen: test names on the left, the patient's result values on the right. Some areas are blacked out or blank on purpose.

Return ONLY a JSON object. Keys must come from this list and nothing else:
${KEYS.join(", ")}
Map the screen's names to keys, e.g. "Sodium-WB" -> Na, "Chloride - WB" -> Cl, "Potassium-WB" -> K, "BEb"/"BEecf"/"Base excess" -> BE, "Anion gap - WB" -> AG, "Carboxyhemoglobin-WB" -> coHb, "Methemoglobin - WB" -> metHb, "Ionized Calcium - WB" -> calcium, "HCT-Blood Gas" -> Hct, "tHb - WB" -> tHb, "Glucose-WB" -> glucose, "Lactate-WB" -> lactate.
Each value is the number exactly as printed in the result column, as a string, keeping the minus sign and every decimal digit ("-6.3", "7.280", "5.20"). Ignore reference ranges, units, flags and colours.
If a row is cut off, blurred or you are not sure of a digit, leave that key out. Never guess. Never compute a value that is not printed.`;

const MAX_B64 = 3_000_000;          // a strip is ~0.5–1.4 MB of base64

// The same rule the phone uses: a word with six or more digits, once the
// letters OCR mistakes for digits are read as digits, or a line made only of
// digit groups ("400 706 123"). A result never has six digits.
export function idLike(text) {
  for (const line of String(text || "").split(/\n/)) {
    const t = line.trim();
    if (/^[\d\s\-\/:]+$/.test(t) && (t.match(/\d/g) || []).length >= 6) return true;
    for (const w of t.split(/\s+/)) {
      const d = w.replace(/[OoQD]/g, "0").replace(/[lI|]/g, "1");
      if ((d.match(/\d/g) || []).length >= 6) return true;
    }
  }
  return false;
}

// tCO2 = HCO3 + 0.0301*pCO2 (mmHg) ; printed gap = Na + K - Cl - HCO3.
// Judged only when every number involved is present — absence is not failure.
export function checksums(v) {
  const n = (k) => (v[k] == null ? null : Number(v[k]));
  const out = {};
  if ([n("tCO2"), n("HCO3"), n("pCO2")].every((x) => x != null && isFinite(x)) && n("pCO2") > 15)
    out.tCO2 = Math.abs(n("HCO3") + 0.0301 * n("pCO2") - n("tCO2")) <= 0.25;
  if ([n("AG"), n("Na"), n("K"), n("Cl"), n("HCO3")].every((x) => x != null && isFinite(x)))
    out.AG = Math.abs(n("Na") + n("K") - n("Cl") - n("HCO3") - n("AG")) <= 1.0;
  return out;
}
const fails = (c) => Object.values(c).some((ok) => ok === false);

export function parseReply(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let raw; try { raw = JSON.parse(m[0]); } catch { return null; }
  // tolerate {"values": {...}} and keys in another case ("na", "PH")
  if (raw && typeof raw.values === "object" && raw.values) raw = raw.values;
  const lower = {};
  for (const [k, v] of Object.entries(raw || {})) lower[String(k).toLowerCase()] = v;
  const vals = {};
  for (const k of KEYS) {
    const s = raw[k] != null ? raw[k] : lower[k.toLowerCase()];
    if (s == null) continue;
    const t = String(s).trim().replace(",", ".").replace(/^[−–]/, "-");
    if (/^-?\d{1,4}(\.\d{1,3})?$/.test(t)) vals[k] = t;   // anything else is dropped
  }
  return vals;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export function keyFor(secret, device) {
  const h = createHmac("sha256", secret).update(`acidbase-scout|${device}`).digest();
  let flat = "";
  for (let i = 0; i < 16; i++) flat += ALPHABET[h[i] % 32];
  return flat;
}

function cost(model, usage) {
  const p = PRICES[model]; if (!p || !usage) return 0;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
}

// ★ THINKING OFF FOR A READING JOB. The 5.x models think by default, and the
// thinking counts against max_tokens: the first live run spent all 2000 tokens
// thinking and returned no text at all (stop: max_tokens). Reading printed
// numbers off a strip gains nothing from it. Per the API's model table:
// Haiku 5.5 accepts {type:"disabled"} (at effort high or below — the default
// is medium); Sonnet 5.5 rejects "disabled" and takes {type:"between_tools"}
// instead; models where thinking is always on get low effort and more room.
export function thinkingFor(model) {
  if (/haiku-5/.test(model)) return { thinking: { type: "disabled" }, max_tokens: 1500 };
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" }, max_tokens: 1500 };
  return { output_config: { effort: "low" }, max_tokens: 6000 };
}

async function askClaude(model, b64, mediaType) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // no `temperature`: the 4.7+/5.x models reject it (400 "deprecated");
      // the prompt's "never guess" and the checksums do the work instead
      model, ...thinkingFor(model),
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  if (!r.ok) {
    let msg = ""; try { const e = await r.json(); msg = e && e.error && e.error.message; } catch {}
    throw new Error(`model answered ${r.status}${msg ? ": " + String(msg).slice(0, 120) : ""}`);
  }
  const d = await r.json();
  const text = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const kinds = (d.content || []).map((c) => c.type).join(",");
  return { text, usage: d.usage || {}, stop: d.stop_reason || "?", kinds };
}

async function underCaps(device) {
  const day = new Date().toISOString().slice(0, 10);
  const store = getStore("cloud-read");
  const all = Number(await store.get(`day:${day}`)) || 0;
  const mine = Number(await store.get(`dev:${day}:${device}`)) || 0;
  if (all >= Number(process.env.CLOUD_DAILY_CAP || 500)) return false;
  if (mine >= Number(process.env.CLOUD_DEVICE_CAP || 60)) return false;
  await store.set(`day:${day}`, String(all + 1));
  await store.set(`dev:${day}:${device}`, String(mine + 1));
  return true;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY || !process.env.TRIAL_SECRET)
    return json(503, { error: "cloud check isn't set up on the server yet" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "bad request" }); }
  const { image, mediaType = "image/jpeg", phoneText = "" } = body || {};
  const device = norm(body && body.device), key = norm(body && body.key);
  if (device.length !== 8 || typeof image !== "string") return json(400, { error: "bad request" });
  if (key !== keyFor(process.env.TRIAL_SECRET, device)) return json(403, { error: "this device's licence key wasn't accepted" });
  if (!/^image\/(jpeg|png)$/.test(mediaType)) return json(400, { error: "bad image type" });
  if (image.length > MAX_B64) return json(413, { error: "strip too large" });
  // the phone sends the text its own reader still sees in the finished strip;
  // an identifier-like number there means the strip is not read
  if (idLike(phoneText)) return json(422, { error: "the strip still holds an ID-like number" });
  if (!(await underCaps(device))) return json(429, { error: "today's cloud limit is reached" });

  const cheap = process.env.CLOUD_READ_MODEL || "claude-haiku-5-5";
  const strong = process.env.CLOUD_READ_ESCALATE ?? "claude-sonnet-5-5";
  try {
    let model = cheap;
    const first = await askClaude(cheap, image, mediaType);
    let values = parseReply(first.text) || {};
    let checks = checksums(values);
    let spent = cost(cheap, first.usage);
    const usage = { input_tokens: first.usage.input_tokens || 0, output_tokens: first.usage.output_tokens || 0 };
    // one retry on the stronger model, only when the cheap read contradicts itself
    if (fails(checks) && strong && strong !== cheap) {
      const second = await askClaude(strong, image, mediaType);
      spent += cost(strong, second.usage);
      usage.input_tokens += second.usage.input_tokens || 0;
      usage.output_tokens += second.usage.output_tokens || 0;
      const v2 = parseReply(second.text) || {};
      const c2 = checksums(v2);
      if (!fails(c2) && Object.keys(v2).length) { model = strong; values = v2; checks = c2; }
    }
    // ★ an empty answer is a fault to SHOW, not a quiet "nothing": say what the
    // model did, so the phone's card can tell Alex instead of a blank
    if (!Object.keys(values).length) {
      const said = String(first.text || "").replace(/\s+/g, " ").slice(0, 140);
      return json(502, { error: `the model returned no values (stop: ${first.stop}; blocks: ${first.kinds || "none"}${said ? `; said: "${said}"` : ""})`,
                         usage, costUSD: Math.round(spent * 1e6) / 1e6 });
    }
    return json(200, { values, checks, model, usage, costUSD: Math.round(spent * 1e6) / 1e6 });
  } catch (e) {
    return json(502, { error: String((e && e.message) || e).slice(0, 200) });
  }
};
