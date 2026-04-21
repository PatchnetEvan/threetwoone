// boxclock Worker — thin API layer in front of Cloudflare KV.
//
// Routes:
//   GET  /api/wod?date=YYYY-MM-DD    public — returns owner-published WOD or 404
//   POST /api/admin/wod              owner-only — { date, title, description, timer? }
//   DELETE /api/admin/wod?date=...   owner-only — unpublish
//   *                                falls through to the static assets bundle
//
// Auth on /api/admin/* is enforced by Cloudflare Access at the edge.
// We additionally verify the Cf-Access-Jwt-Assertion header inside the
// Worker so that a misconfigured Access policy can't silently expose us.

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/wod" && request.method === "GET") {
        return await handleGet(url, env);
      }
      if (pathname === "/api/admin/wod") {
        const user = await verifyAccess(request, env);
        if (!user) return json({ error: "unauthorized" }, 401);
        if (request.method === "POST")   return await handlePost(request, env);
        if (request.method === "DELETE") return await handleDelete(url, env);
        return json({ error: "method not allowed" }, 405);
      }
    } catch (err) {
      return json({ error: "server error", detail: String(err) }, 500);
    }

    // Everything else → static assets (index.html, app.js, etc.)
    return env.ASSETS.fetch(request);
  },
};

// ── Route handlers ──────────────────────────────────────────────────

async function handleGet(url, env) {
  const date = url.searchParams.get("date");
  if (!date || !ISO_DATE.test(date)) return json({ error: "bad date" }, 400);
  const raw = await env.WOD.get(`wod:${date}`);
  if (!raw) return json({ error: "not found" }, 404);
  // Stored as JSON already — just pass through.
  return new Response(raw, { headers: JSON_HEADERS });
}

async function handlePost(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const { date, title, description, timer } = body || {};
  if (!date || !ISO_DATE.test(date)) return json({ error: "bad date" }, 400);
  if (!title || typeof title !== "string") return json({ error: "title required" }, 400);
  const entry = { title: title.slice(0, 200), description: String(description || "").slice(0, 4000) };
  if (timer && typeof timer === "object") entry.timer = timer;
  await env.WOD.put(`wod:${date}`, JSON.stringify(entry));
  return json({ ok: true, date, entry });
}

async function handleDelete(url, env) {
  const date = url.searchParams.get("date");
  if (!date || !ISO_DATE.test(date)) return json({ error: "bad date" }, 400);
  await env.WOD.delete(`wod:${date}`);
  return json({ ok: true, date });
}

// ── Cloudflare Access JWT verification ──────────────────────────────
//
// Cloudflare Access signs an RS256 JWT for every authenticated request
// and puts it in `Cf-Access-Jwt-Assertion`. We verify:
//   1. Signature against the team's public JWKS
//   2. `aud` matches our Access application AUD tag (env.ACCESS_AUD)
//   3. `exp` has not passed
//   4. `iss` matches our team domain
// Without all four, reject. This makes a broken/disabled Access policy
// fail closed rather than fail open.

async function verifyAccess(request, env) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlToText(headerB64));
    payload = JSON.parse(b64urlToText(payloadB64));
  } catch { return null; }

  if (header.alg !== "RS256" || !header.kid) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
  const expectedIss = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  if (payload.iss !== expectedIss) return null;

  // Fetch JWKS — edge-cached by Cloudflare, no in-process cache needed.
  const certsUrl = `${expectedIss}/cdn-cgi/access/certs`;
  const certs = await fetch(certsUrl, { cf: { cacheTtl: 3600 } }).then(r => r.json());
  const jwk = certs.keys?.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) return null;

  return { email: payload.email, sub: payload.sub };
}

function b64urlToText(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
