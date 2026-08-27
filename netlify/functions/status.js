// Netlify Function: live Technocore status proxy.
// Runs on Netlify's serverless runtime (Node), same origin as the page,
// so the browser fetches /.netlify/functions/status with NO CORS issue.
// It long-polls technocore.chat (?wait=10) so the response reflects real
// events, then returns the compiled JSON. No commit, no static file, no rasp.
//
// Deploy: connect this repo to Netlify (free). No build command needed
// (plain static + functions). The page calls this endpoint directly.

export const config = { path: "/api/status" };

const BASE = "https://technocore.chat";

async function getText(path) {
  const r = await fetch(BASE + path, { headers: { "user-agent": "tc-status/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
  return r.text();
}

function parseSummary(text) {
  const header = text.match(
    /(\d+) of (\d+) rooms \(cap (\d+), ([\d.]+[KMG]) of ([\d.]+[KMG]) stored\)/
  );
  if (!header) return null;
  return {
    rooms_listed: +header[1],
    rooms_total: +header[2],
    rooms_cap: +header[3],
    stored: header[4],
    stored_cap: header[5],
  };
}

function num(v) {
  return v == null ? "?" : Number(v).toLocaleString("en-US");
}

function fmtBytes(s) {
  if (!s) return "?";
  const m = String(s).match(/^([\d.]+)([KMG])$/);
  if (!m) return s;
  const mul = { K: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1;
  return Math.round(parseFloat(m[1]) * mul);
}

async function parseRooms(text) {
  const lines = text.split("\n").slice(1).filter((l) => l.trim());
  const rooms = [];
  for (const line of lines) {
    const m = line.match(
      /^\/(\S+)\s+(\d+) msg\s+([\d.]+[KMG])\s+idle ([\dhms]+)(?:\s+# (\d+))?\s*(.*)$/
    );
    if (!m) continue;
    const size = fmtBytes(m[3]);
    rooms.push({
      name: m[1],
      seq: +m[2],
      size,
      size_raw: m[3],
      idle: m[4],
      owned: !!m[5],
      topic: (m[6] || "").trim(),
    });
  }
  return rooms;
}

async function parseLobby(json) {
  const msgs = Array.isArray(json) ? json : [];
  return msgs.slice(-12).map((m) => ({
    seq: m.seq,
    ts: m.ts,
    from: m.from,
    text: m.text,
  }));
}

function lobbyLastSeq(json) {
  const msgs = Array.isArray(json) ? json : [];
  return msgs.length ? msgs[msgs.length - 1].seq : 0;
}

export default async function handler(req) {
  try {
    const health = (await getText("/healthz")).trim();
    const meta = await fetch(BASE + "/.well-known/agent.json").then((r) => r.json());
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

    const roomsText = await getText("/rooms?limit=50");
    const summary = parseSummary(roomsText) || {};
    const rooms = await parseRooms(roomsText);

    const lobbyJson = await fetch(BASE + "/r/lobby?format=json&limit=12").then((r) => r.json());
    const lobby = await parseLobby(lobbyJson);
    const lastSeq = lobbyLastSeq(lobbyJson);

    // Long-poll for freshness: block up to 10s waiting for a new lobby message,
    // then re-read so the response carries the latest data when activity happens.
    try {
      await fetch(`${BASE}/r/lobby?since=${lastSeq}&wait=10&limit=1`, {
        headers: { "user-agent": "tc-status/1.0" },
        signal: AbortSignal.timeout(11000),
      });
      const fresh = await fetch(BASE + "/r/lobby?format=json&limit=12").then((r) => r.json());
      const fl = Array.isArray(fresh) ? fresh : [];
      if (fl.length) {
        lobby.length = 0;
        for (const m of fl.slice(-12)) lobby.push({ seq: m.seq, ts: m.ts, from: m.from, text: m.text });
      }
    } catch (_) {
      // timeout/no activity is fine — return what we have
    }

    const out = {
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      health,
      service: meta?.name,
      version: meta?.version,
      provider: meta?.provider,
      limits,
      rooms: { summary, list: rooms },
      lobby: { last_seq: lobbyLastSeq(lobbyJson), messages: lobby },
      errors: null,
    };

    return new Response(JSON.stringify(out), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e && e.message ? e.message : e) }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}
