// Netlify Function: DID Inspector.
// Input: ?did=did:key:...
// Output: JSON with identity note (verified?) + lobby message stats for that DID.
// NOTE: technocore.chat has NO global DID index, so we can only inspect what is
// visible in /r/lobby (a ring buffer). This is room-scoped, not system-wide.

export const config = { path: "/api/did" };

const BASE = "https://technocore.chat";

async function get(path, asJson = false) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(BASE + path, {
        headers: { accept: asJson ? "application/json" : "text/plain" },
      });
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return asJson ? await r.json() : await r.text();
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  throw new Error("fetch failed " + path);
}

function fingerprint(did) {
  // SHA-256 of the DID string, lowercase hex, first 16 chars.
  // Uses Web Crypto (available in Node 18+ edge runtime via globalThis.crypto).
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
      // /kv/did/<fp> returns the raw note text (or "not found")
      if (raw && !/not found/i.test(raw)) note = raw.trim();
    } catch (e) {
      noteError = String(e.message || e);
    }

    // Scan lobby (ring buffer, up to 200 recent messages)
    const lobby = await get("/r/lobby?format=json&limit=200", true);
    const msgs = Array.isArray(lobby)
      ? lobby
      : lobby && Array.isArray(lobby.messages)
      ? lobby.messages
      : [];
    const mine = msgs
      .filter((m) => m.from === did)
      .map((m) => ({ seq: m.seq, ts: m.ts, text: m.text }));

    const out = {
      did,
      fingerprint: fp,
      verified: note !== null,
      note,
      note_error: noteError,
      lobby: {
        scanned: msgs.length,
        count: mine.length,
        messages: mine.slice(-20),
      },
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
