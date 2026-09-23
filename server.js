import "dotenv/config";
import express from "express";
import { io } from "socket.io-client";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API = "https://openapi.chzzk.naver.com";

app.use(express.json());
app.use(express.static("public"));

const clients = new Set();
const channelSessions = new Map(); // channelId -> { socket, sessionKey, subscribers:Set }

function requireKeys(res) {
  if (!process.env.CHZZK_CLIENT_ID || !process.env.CHZZK_CLIENT_SECRET) {
    res.status(500).json({
      error: "CHZZK_CLIENT_ID / CHZZK_CLIENT_SECRET가 설정되지 않았습니다."
    });
    return false;
  }
  return true;
}

function extractChannelId(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  // 채널 ID 자체를 넣은 경우
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value) && !value.includes("/")) {
    return value;
  }

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const liveIndex = parts.findIndex(p => p.toLowerCase() === "live");
    if (liveIndex >= 0 && parts[liveIndex + 1]) return parts[liveIndex + 1];
    return parts.at(-1) || null;
  } catch {
    return null;
  }
}

async function chzzkFetch(path, options = {}) {
  const headers = {
    "Client-Id": process.env.CHZZK_CLIENT_ID,
    "Client-Secret": process.env.CHZZK_CLIENT_SECRET,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  return fetch(API + path, { ...options, headers });
}

async function getChannel(channelId) {
  const r = await chzzkFetch(`/open/v1/channels?channelIds=${encodeURIComponent(channelId)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `채널 조회 실패 (${r.status})`);
  return data?.content?.data?.[0] || data?.content?.[0] || data?.data?.[0] || null;
}

async function createSession() {
  const r = await chzzkFetch("/open/v1/sessions/auth/client");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `세션 생성 실패 (${r.status})`);
  const url = data?.content?.url || data?.url;
  if (!url) throw new Error("세션 URL을 받지 못했습니다.");
  return url;
}

async function subscribeChat(sessionKey) {
  const r = await chzzkFetch(
    `/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`,
    { method: "POST" }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `채팅 구독 실패 (${r.status})`);
}

function broadcast(channelId, event) {
  const state = channelSessions.get(channelId);
  if (!state) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.subscribers) {
    try { res.write(payload); } catch {}
  }
}

async function getOrCreateChannelSession(channelId) {
  let state = channelSessions.get(channelId);
  if (state) return state;

  const sessionURL = await createSession();

  state = {
    socket: null,
    sessionKey: null,
    subscribers: new Set()
  };

  const socket = io.connect(sessionURL, {
    reconnection: false,
    "force new connection": true,
    "connect timeout": 5000,
    transports: ["websocket"]
  });

  state.socket = socket;
  channelSessions.set(channelId, state);

  socket.on("connect_error", (err) => {
    broadcast(channelId, { type: "error", message: "치지직 실시간 연결에 실패했습니다." });
  });

  socket.on("SYSTEM", async (raw) => {
    try {
      const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (msg?.type === "connected") {
        state.sessionKey = msg.data.sessionKey;
        await subscribeChat(state.sessionKey);
      }
      if (msg?.type === "subscribed") {
        broadcast(channelId, { type: "status", message: "실시간 채팅 연결 완료" });
      }
      if (msg?.type === "revoked") {
        broadcast(channelId, { type: "error", message: "채팅 권한이 취소되었습니다." });
      }
    } catch (e) {
      broadcast(channelId, { type: "error", message: "SYSTEM 메시지 처리 오류" });
    }
  });

  socket.on("CHAT", (raw) => {
    try {
      const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (msg?.channelId !== channelId) return;

      broadcast(channelId, {
        type: "chat",
        nickname: msg?.profile?.nickname || "알 수 없음",
        content: msg?.content || "",
        role: msg?.userRoleCode || "",
        verified: Boolean(msg?.profile?.verifiedMark),
        emojis: msg?.emojis || {},
        time: msg?.messageTime || Date.now()
      });
    } catch {}
  });

  socket.on("disconnect", () => {
    const current = channelSessions.get(channelId);
    if (current?.socket === socket) {
      channelSessions.delete(channelId);
    }
    broadcast(channelId, { type: "error", message: "실시간 연결이 종료되었습니다." });
  });

  return state;
}

app.get("/api/channel", async (req, res) => {
  try {
    if (!requireKeys(res)) return;
    const channelId = extractChannelId(req.query.url || req.query.channelId);
    if (!channelId) return res.status(400).json({ error: "치지직 방송 URL 또는 채널 ID를 확인해주세요." });

    const channel = await getChannel(channelId);
    if (!channel) return res.status(404).json({ error: "채널을 찾을 수 없습니다." });

    res.json({
      channelId,
      channelName: channel.channelName || "알 수 없는 채널",
      channelImageUrl: channel.channelImageUrl || "",
      followerCount: channel.followerCount || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/stream", async (req, res) => {
  try {
    if (!requireKeys(res)) return;
    const channelId = extractChannelId(req.query.url || req.query.channelId);
    if (!channelId) return res.status(400).end("잘못된 채널입니다.");

    const channel = await getChannel(channelId);
    if (!channel) return res.status(404).end("채널을 찾을 수 없습니다.");

    const state = await getOrCreateChannelSession(channelId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    state.subscribers.add(res);
    res.write(`data: ${JSON.stringify({
      type: "channel",
      channelId,
      channelName: channel.channelName || "",
      channelImageUrl: channel.channelImageUrl || ""
    })}\n\n`);

    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      state.subscribers.delete(res);
      if (state.subscribers.size === 0) {
        setTimeout(() => {
          const current = channelSessions.get(channelId);
          if (current && current.subscribers.size === 0) {
            try { current.socket.disconnect(); } catch {}
            channelSessions.delete(channelId);
          }
        }, 30000);
      }
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

app.get("*splat", (req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

app.listen(PORT, () => {
  console.log(`Chat viewer running on http://localhost:${PORT}`);
});