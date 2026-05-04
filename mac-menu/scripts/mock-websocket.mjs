#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || process.env.WALKINGPAD_MOCK_PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
let dailySteps = Number(process.env.WALKINGPAD_MOCK_START_STEPS || 1200);
const clients = new Set();

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("WalkingPad mock WebSocket. Connect with ws://127.0.0.1:8787/\n");
});

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  socket.on("data", () => {});

  send(socket, snapshot());
});

setInterval(() => {
  dailySteps += Math.floor(Math.random() * 9) + 1;
  broadcast(snapshot());
}, 1000).unref();

server.listen(port, host, () => {
  console.log(`WalkingPad mock WebSocket listening on ws://${host}:${port}/`);
});

function snapshot() {
  return {
    type: "live_status",
    dailySteps,
    sessionSteps: dailySteps - Number(process.env.WALKINGPAD_MOCK_START_STEPS || 1200),
    isWalking: true,
    updatedAt: new Date().toISOString(),
  };
}

function broadcast(message) {
  for (const socket of clients) {
    send(socket, message);
  }
}

function send(socket, message) {
  if (socket.destroyed) {
    clients.delete(socket);
    return;
  }

  const payload = Buffer.from(JSON.stringify(message));
  const header = frameHeader(payload.length);
  socket.write(Buffer.concat([header, payload]));
}

function frameHeader(length) {
  if (length < 126) {
    return Buffer.from([0x81, length]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}
