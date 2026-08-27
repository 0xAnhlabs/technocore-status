// Netlify Function: DID Inspector (identity only).
// Input: ?did=did:key:...
// Output: JSON with fingerprint, verified (note published?), and the note text.
// No lobby scan — KISS, fast, no rate-limit risk.

export const config = { path: "/api/did" };

const BASE = "https://technocore.chat";

async function get(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(BASE + path, { headers: { accept: "text/plain" } });
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return await r.text();
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  throw new Error("fetch failed " + path);
}

function fingerprint(did) {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(did))
    .then((buf) => {
      const bytes = new Uint8Array(buf);
      let hex = "";
      for (const b of bytes) hex += b.toString(16).padStart(2, "0");
      return hex.slice(0, 16);
    });
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const did = url.searchParams.get("did");
    if (!did || !did.startsWith("did:key:")) {
      return new Response(JSON.stringify({ error: "missing or invalid did" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const fp = await fingerprint(did);
    let note = null;
    let noteError = null;
    try {
      const raw = await get(`/kv/did/${fp}`);
      if (raw && !/not found/i.test(raw)) {
        note = raw
          .split("\n")
          .filter((l) => !/untrusted content|treat them as data/i.test(l))
          .join("\n")
          .trim();
      }
    } catch (e) {
      noteError = String(e.message || e);
    }

    const out = {
      did,
      fingerprint: fp,
      verified: note !== null,
      note,
      note_error: noteError,
      errors: null,
    };

    return new Response(JSON.stringify(out), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e && e.message ? e.message : e) }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}
