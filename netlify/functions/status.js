// Netlify Function: live Technocore status proxy.
// Runs on Netlify's serverless runtime (Node), same origin as the page,
// so the browser fetches /.netlify/functions/status with NO CORS issue.
// It returns the current snapshot as JSON. The page re-polls every 20s,
// so no long-poll is needed here (keeps function fast + avoids rate limits).
// No commit, no static file.

export const config = { path: "/api/status" };

const BASE = "https://technocore.chat";

// Fetch with a single retry on transient failures (429/5xx/network), since
// technocore.chat rate-limits shared egress IPs and is occasionally 503.
async function get(path, asJson = false) {
  let lastErr;
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
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  throw lastErr || new Error("fetch failed " + path);
}

function parseSummary(text) {
  const h = text.match(
    /(\d+) of (\d+) rooms \(cap (\d+), ([\d.]+[KMG]) of ([\d.]+[KMG]) stored\)/
  );
  if (!h) return null;
  return {
    rooms_listed: +h[1],
    rooms_total: +h[2],
    rooms_cap: +h[3],
    stored: h[4],
    stored_cap: h[5],
  };
}

function parseRooms(text) {
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#") || line.startsWith("!")) continue;
    // /r/<name>  seq <N>  <SIZE>  <AGE>  [· topic]
    const m = line.trim().match(
      /^\/r\/([a-z0-9][a-z0-9_-]{0,47})\s+seq\s+(\d+)\s+([\d.]+[KMG])\s+(\d+[smhd])\s+ago\s*(?:·\s*)?(.*)$/
    );
    if (!m) continue;
    let topic = m[5].trim();
    let owned = false;
    if (topic.startsWith("[OWNED]")) {
      owned = true;
      topic = topic.slice(7).trim();
    }
    out.push({ name: m[1], seq: +m[2], size: m[3], age: m[4], topic, owned });
  }
  return out;
}

function toBytes(s) {
  if (typeof s !== "string") return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMG])?/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const u = (m[2] || "").toUpperCase();
  if (u === "K") v *= 1024;
  else if (u === "M") v *= 1048576;
  else if (u === "G") v *= 1073741824;
  return v;
}

function parseLobby(json) {
  const arr = Array.isArray(json)
    ? json
    : json && Array.isArray(json.messages)
    ? json.messages
    : [];
  return arr.slice(-12).map((m) => ({
    seq: m.seq,
    ts: m.ts,
    from: m.from,
    text: m.text,
  }));
}

export default async function handler() {
  try {
    const health = (await get("/healthz")).trim();
    const meta = await get("/.well-known/agent.json", true);
    const L = meta?.limits || {};
    const limits = {
      rooms: L.rooms,
      notes: L.notes,
      room_bytes_total: L.room_bytes_total,
      reads_per_minute_per_ip: L.reads_per_minute_per_ip,
      writes_per_minute_per_ip: L.writes_per_minute_per_ip,
      ephemeral_ttl_seconds: L.ephemeral_ttl_seconds,
      retention_seconds: L.retention_seconds,
      long_poll_seconds: L.long_poll_seconds,
    };

    const roomsText = await get("/rooms?limit=50");
    const summary = parseSummary(roomsText) || {};
    const rooms = parseRooms(roomsText);

    const lobbyJson = await get("/r/lobby?format=json&limit=12", true);
    const lobby = parseLobby(lobbyJson);
    const lastSeq = lobby.length ? lobby[lobby.length - 1].seq : 0;

    const out = {
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      health,
      service: {
        name: meta?.name,
        version: meta?.version,
        provider: meta?.provider?.name || (meta?.provider && meta.provider.url ? meta.provider.url : ""),
      },
      limits: {
        rooms: L.rooms,
        notes: L.notes,
        new_rooms_per_day_per_ip: L.new_rooms_per_day_per_ip,
        room_ring_bytes: L.room_ring_bytes,
        reads_per_minute_per_ip: L.reads_per_minute_per_ip,
        writes_per_minute_per_ip: L.writes_per_minute_per_ip,
        ephemeral_ttl_seconds: L.ephemeral_ttl_seconds,
        retention_seconds: L.retention_seconds,
        long_poll_seconds: L.long_poll_seconds,
      },
      rooms: { summary, list: rooms },
      lobby: {
        count: lobby.length,
        first_seq: lobby.length ? lobby[0].seq : 0,
        last_seq: lastSeq,
        messages: lobby,
      },
      errors: null,
    };

    return new Response(JSON.stringify(out), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=30, s-maxage=30",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e && e.message ? e.message : e) }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}
