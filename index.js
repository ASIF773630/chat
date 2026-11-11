import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 3001);
const maxMessagesPerWindow = 40;
const rateWindowMs = 10_000;
let nextClientId = 1;
const waiting = new Set();
const server = new WebSocketServer({ port, host: "0.0.0.0", maxPayload: 24 * 1024 });

function send(client, message) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function compatible(first, second) {
  const countryMatches =
    first.country === "Worldwide" ||
    second.country === "Worldwide" ||
    first.country === second.country;
  const interestsMatch =
    first.interests.length === 0 ||
    second.interests.length === 0 ||
    first.interests.some((interest) => second.interests.includes(interest));
  return countryMatches && interestsMatch;
}

function detach(client, notifyPeer = true) {
  waiting.delete(client);
  const peer = client.peer;
  client.peer = null;
  if (peer) {
    peer.peer = null;
    if (notifyPeer) send(peer, { type: "peer_left" });
  }
}

function findMatch(client) {
  for (const candidate of waiting) {
    if (
      candidate !== client &&
      candidate.readyState === WebSocket.OPEN &&
      compatible(client, candidate)
    ) {
      waiting.delete(candidate);
      client.peer = candidate;
      candidate.peer = client;
      send(client, { type: "matched", peerId: candidate.id });
      send(candidate, { type: "matched", peerId: client.id });
      return;
    }
  }
  waiting.add(client);
  send(client, { type: "waiting" });
}

function handleMessage(client, raw) {
  const now = Date.now();
  client.messageTimes = client.messageTimes.filter((time) => now - time < rateWindowMs);
  client.messageTimes.push(now);
  if (client.messageTimes.length > maxMessagesPerWindow) {
    send(client, { type: "error", message: "Too many requests. Slow down." });
    return;
  }

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(client, { type: "error", message: "Invalid JSON request." });
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send(client, { type: "error", message: "Invalid request." });
    return;
  }

  if (message.type === "join") {
    if (client.country) {
      send(client, { type: "error", message: "You are already in the matching queue." });
      return;
    }
    const countries = new Set(["Worldwide", "India", "UAE", "USA", "UK"]);
    client.country = countries.has(message.country) ? message.country : "Worldwide";
    client.interests = Array.isArray(message.interests)
      ? message.interests.filter((item) => typeof item === "string").slice(0, 6)
      : [];
    findMatch(client);
    return;
  }

  if (message.type === "leave") {
    detach(client);
    client.country = null;
    send(client, { type: "left" });
    return;
  }

  if (message.type === "report") {
    if (client.peer) {
      console.warn(`Anonymous report: client ${client.id} reported client ${client.peer.id}`);
    }
    detach(client);
    client.country = null;
    send(client, { type: "reported" });
    return;
  }

  if (message.type === "chat") {
    if (!client.peer || typeof message.text !== "string") {
      send(client, { type: "error", message: "You are not in a chat." });
      return;
    }
    const text = message.text.trim();
    if (!text || text.length > 2000) {
      send(client, { type: "error", message: "Messages must be 1–2000 characters." });
      return;
    }
    send(client.peer, { type: "chat", text });
    return;
  }

  if (message.type === "signal") {
    if (!client.peer || !message.signal || typeof message.signal !== "object") {
      send(client, { type: "error", message: "No active chat for call signaling." });
      return;
    }
    send(client.peer, { type: "signal", signal: message.signal });
    return;
  }

  send(client, { type: "error", message: "Unknown request type." });
}

server.on("connection", (client) => {
  client.id = nextClientId++;
  client.country = null;
  client.interests = [];
  client.peer = null;
  client.messageTimes = [];
  client.on("message", (raw) => handleMessage(client, raw));
  client.on("close", () => detach(client));
  client.on("error", (error) => {
    console.error(`WebSocket client ${client.id} error:`, error.message);
    detach(client);
  });
});

server.on("listening", () => {
  console.log(`ConnectX match server listening on port ${port}`);
});

server.on("error", (error) => {
  console.error("Match server failed:", error);
  process.exitCode = 1;
});
