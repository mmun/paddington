"use strict";

const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { COMMAND_DEFS, buildCommand, fromHex } = require("./protocol");
const { WalkingPadBle } = require("./walkingpad-ble");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const ble = new WalkingPadBle();
let shuttingDown = false;

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/state", (request, response) => {
  response.json({ state: ble.getSnapshot(), commands: COMMAND_DEFS });
});

app.post("/api/connect", asyncHandler(async (request, response) => {
  await ble.connect(request.body || {});
  response.json({ ok: true });
}));

app.post("/api/disconnect", asyncHandler(async (request, response) => {
  await ble.disconnect();
  response.json({ ok: true });
}));

app.post("/api/read-all", asyncHandler(async (request, response) => {
  await ble.readAllKnown();
  response.json({ ok: true });
}));

app.post("/api/read/:id", asyncHandler(async (request, response) => {
  const data = await ble.readCharacteristic(request.params.id);
  response.json({ ok: true, hex: data.toString("hex").toUpperCase() });
}));

app.post("/api/command", asyncHandler(async (request, response) => {
  const { id, args } = request.body || {};
  const command = buildCommand(id, args || {});
  await runCommand(command);
  response.json({ ok: true });
}));

app.post("/api/write", asyncHandler(async (request, response) => {
  const { characteristicId, hex, withoutResponse } = request.body || {};
  const data = fromHex(hex);
  await ble.writeCharacteristic(characteristicId, data, {
    withoutResponse: Boolean(withoutResponse),
    label: "raw write"
  });
  response.json({ ok: true });
}));

app.post("/api/shutdown", (request, response) => {
  response.json({ ok: true });
  setTimeout(() => shutdown("api"), 25).unref();
});

const server = app.listen(PORT, HOST, () => {
  ble.log("server", `listening on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  send(socket, { type: "snapshot", state: ble.getSnapshot(), commands: COMMAND_DEFS });
});

ble.on("update", (state) => {
  broadcast({ type: "snapshot", state, commands: COMMAND_DEFS });
});

ble.on("log", (entry) => {
  broadcast({ type: "log", entry });
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function runCommand(command) {
  if (command.kind === "ftms-sequence") {
    await ble.writeFtmsSequence(command.steps);
    return;
  }
  if (command.kind === "write") {
    await ble.writeCharacteristic(command.characteristicId, command.data, {
      withoutResponse: command.withoutResponse,
      label: command.label || command.characteristicId
    });
    return;
  }
  throw new Error(`Unsupported command kind: ${command.kind}`);
}

function broadcast(message) {
  for (const client of wss.clients) {
    if (client.readyState === 1) send(client, message);
  }
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function asyncHandler(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response, next);
    } catch (error) {
      ble.log("error", error.message);
      response.status(500).json({ ok: false, error: error.message });
    }
  };
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  ble.log("server", `shutdown requested: ${reason}`);
  const force = setTimeout(() => {
    console.error("forced shutdown");
    process.exit(0);
  }, 2500);
  force.unref();

  for (const client of wss.clients) {
    try {
      client.close(1001, "server shutdown");
      client.terminate();
    } catch {
      // Ignore websocket close failures during shutdown.
    }
  }

  ble.close()
    .catch(() => {})
    .finally(() => {
      server.close(() => {
        clearTimeout(force);
        process.exit(0);
      });
      setTimeout(() => {
        clearTimeout(force);
        process.exit(0);
      }, 750).unref();
    });
}
