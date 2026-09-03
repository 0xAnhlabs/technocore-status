// Netlify Function: live Technocore status proxy.
// Runs on Netlify's serverless runtime (Node), same origin as the page,
// so the browser fetches /.netlify/functions/status with NO CORS issue.
// It returns the current snapshot as JSON. The page re-polls every 20s,
// so no long-poll is needed here (keeps function fast + avoids rate limits).
// No commit, no static file.
//
// Fallback behavior: technocore.chat may return 503 or rate-limit shared IPs.
// This function now degrades gracefully instead of failing the whole page.

export const config = { path: "/api/status" };

const BASE = "https://technocore.chat";

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
    const m = line.trim().match(
      /^\/([a-z0-9][a-z0-9_-]{0,47})\s+seq\s+(\d+)\s+([\d.]+[KMG])\s+(\d+[smhd])\s+ago\s*(?:·\s*)?(.*)$/
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

function hourFromTs(ts) {
  if (!ts) return null;
  const m = String(ts).match(/T(\d{2}):/);
  return m ? +m[1] : null;
}

function buildActivityHeatmap(messages) {
  const buckets = new Array(24).fill(0);
  let lastHour = -1;
  for (const m of messages) {
    const h = hourFromTs(m.ts);
    if (h === null) continue;
    buckets[h] += 1;
    lastHour = h;
  }
  const max = Math.max(1, ...buckets);
  const now = new Date();
  const currentHour = now.getUTCHours();
  return {
    buckets: buckets.map((count, h) => ({
      hour: h,
      count,
      pct: (count / max) * 100,
      isNow: h === currentHour,
    })),
    max,
    lastHour,
  };
}

function parseOfferLines(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("tclk1 ")) continue;
    const json = line.slice(6).trim();
    let obj;
    try { obj = JSON.parse(json); } catch { continue; }
    if (obj && obj.type === "offer") out.push(obj);
  }
  return out.slice(-50);
}

export default async function handler() {
  try {
    const out = {
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      health: null,
      service: {},
      limits: {},
      rooms: { summary: {}, list: [] },
      lobby: { count: 0, first_seq: 0, last_seq: 0, messages: [] },
      activity_heatmap: null,
      errors: [],
    };

    // healthz is best-effort
    try {
      out.health = (await get("/healthz")).trim();
    } catch (e) {
      out.errors.push("healthz unavailable: " + String(e && e.message ? e.message : e));
    }

    // agent metadata is best-effort
    let meta = {};
    try {
      meta = await get("/.well-known/agent.json", true);
    } catch (e) {
      out.errors.push("agent.json unavailable: " + String(e && e.message ? e.message : e));
      // Try to proceed with defaults
    }
    const L = meta?.limits || {};
    out.service = {
      name: meta?.name,
      version: meta?.version,
      provider: meta?.provider?.name || (meta?.provider && meta.provider.url ? meta.provider.url : ""),
    };
    out.limits = {
      rooms: L.rooms,
      notes: L.notes,
      new_rooms_per_day_per_ip: L.new_rooms_per_day_per_ip,
      room_ring_bytes: L.room_ring_bytes,
      reads_per_minute_per_ip: L.reads_per_minute_per_ip,
      writes_per_minute_per_ip: L.writes_per_minute_per_ip,
      ephemeral_ttl_seconds: L.ephemeral_ttl_seconds,
      retention_seconds: L.retention_seconds,
      long_poll_seconds: L.long_poll_seconds,
    };

    // rooms list is best-effort
    let roomsText = "";
    try {
      roomsText = await get("/rooms?limit=50");
      out.rooms.summary = parseSummary(roomsText) || {};
      out.rooms.list = parseRooms(roomsText);
    } catch (e) {
      out.errors.push("rooms unavailable: " + String(e && e.message ? e.message : e));
    }

    // lobby is best-effort
    let lobbyJson = [];
    let offerText = "";
    try {
      lobbyJson = await get("/r/lobby?format=json&limit=200", true);
      const lobby = parseLobby(lobbyJson);
      out.lobby = {
        count: lobby.length,
        first_seq: lobby.length ? lobby[0].seq : 0,
        last_seq: lobby.length ? lobby[lobby.length - 1].seq : 0,
        messages: lobby,
      };
      out.activity_heatmap = buildActivityHeatmap(lobby);
    } catch (e) {
      out.errors.push("lobby unavailable: " + String(e && e.message ? e.message : e));
    }

    // tclk offers is best-effort
    try {
      offerText = await get("/r/tclk-offers");
      out.tclk_offers = parseOfferLines(offerText);
    } catch (e) {
      out.errors.push("tclk-offers unavailable: " + String(e && e.message ? e.message : e));
      out.tclk_offers = [];
    }

    return new Response(JSON.stringify(out), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=30, s-maxage=30",
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: String(e && e.message ? e.message : e),
        generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        health: null,
        service: {},
        limits: {},
        rooms: { summary: {}, list: [] },
        lobby: { count: 0, first_seq: 0, last_seq: 0, messages: [] },
        activity_heatmap: null,
        errors: ["fatal: " + String(e && e.message ? e.message : e)],
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }
}
