"use strict";

let state = null;
let commands = [];
let socket = null;

const els = {
  adapterState: document.getElementById("adapterState"),
  connectionState: document.getElementById("connectionState"),
  targetLabel: document.getElementById("targetLabel"),
  addressInput: document.getElementById("addressInput"),
  nameInput: document.getElementById("nameInput"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  readAllBtn: document.getElementById("readAllBtn"),
  shutdownBtn: document.getElementById("shutdownBtn"),
  ftmsControls: document.getElementById("ftmsControls"),
  vendorControls: document.getElementById("vendorControls"),
  speedForm: document.getElementById("speedForm"),
  speedInput: document.getElementById("speedInput"),
  rawWriteForm: document.getElementById("rawWriteForm"),
  rawCharacteristic: document.getElementById("rawCharacteristic"),
  rawHex: document.getElementById("rawHex"),
  withoutResponse: document.getElementById("withoutResponse"),
  values: document.getElementById("values"),
  log: document.getElementById("log"),
  valueTemplate: document.getElementById("valueTemplate")
};

boot();

async function boot() {
  const response = await fetchJson("/api/state");
  state = response.state;
  commands = response.commands;
  renderCommandButtons();
  render();
  connectSocket();
  wireEvents();
}

function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      state = message.state;
      commands = message.commands || commands;
      render();
    }
  });
  socket.addEventListener("close", () => {
    setTimeout(connectSocket, 1200);
  });
}

function wireEvents() {
  els.connectBtn.addEventListener("click", () => post("/api/connect", {
    address: els.addressInput.value,
    name: els.nameInput.value
  }));
  els.disconnectBtn.addEventListener("click", () => post("/api/disconnect", {}));
  els.readAllBtn.addEventListener("click", () => post("/api/read-all", {}));
  els.shutdownBtn.addEventListener("click", () => post("/api/shutdown", {}));

  els.speedForm.addEventListener("submit", (event) => {
    event.preventDefault();
    post("/api/command", {
      id: "ftms.setSpeed",
      args: { kmh: Number(els.speedInput.value) }
    });
  });

  els.rawWriteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    post("/api/write", {
      characteristicId: els.rawCharacteristic.value,
      hex: els.rawHex.value,
      withoutResponse: els.withoutResponse.checked
    });
  });

  els.rawHex.addEventListener("input", () => {
    els.rawHex.value = els.rawHex.value.toUpperCase();
  });

  els.addressInput.addEventListener("input", () => {
    els.addressInput.value = els.addressInput.value.toUpperCase();
  });
}

function renderCommandButtons() {
  els.ftmsControls.innerHTML = "";
  els.vendorControls.innerHTML = "";

  const ftms = commands.filter((command) => command.group === "FTMS Control");
  for (const command of ftms) {
    els.ftmsControls.appendChild(commandButton(command));
  }

  const vendorGroups = groupBy(commands.filter((command) => command.group !== "FTMS Control"), "group");
  for (const [group, groupCommands] of vendorGroups.entries()) {
    const section = document.createElement("section");
    section.className = "command-group";
    section.dataset.group = slug(group);
    const heading = document.createElement("h3");
    heading.textContent = group;
    const buttons = document.createElement("div");
    buttons.className = "command-buttons";
    for (const command of groupCommands) {
      buttons.appendChild(commandButton(command));
    }
    section.append(heading, buttons);
    els.vendorControls.appendChild(section);
  }
}

function commandButton(command) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = command.label;
  if (command.id === "ftms.start") button.classList.add("hot");
  button.addEventListener("click", () => post("/api/command", { id: command.id }));
  return button;
}

function render() {
  if (!state) return;
  els.adapterState.textContent = state.adapter.state;
  els.connectionState.textContent = state.connection.status;
  els.targetLabel.textContent = `${state.target.name || "(any)"} / ${formatAddress(state.target.address) || "(any)"}`;
  els.addressInput.value = formatAddress(state.target.address) || els.addressInput.value;
  els.nameInput.value = state.target.name || els.nameInput.value;
  document.body.dataset.status = state.connection.status;
  renderValues();
  renderLog();
}

function renderValues() {
  els.values.innerHTML = "";
  for (const value of state.values) {
    const node = els.valueTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("present", Boolean(value.present));
    node.querySelector(".id").textContent = formatIdentifier(value.id);
    node.querySelector(".name").textContent = value.name;
    node.querySelector(".state").textContent = value.notifying ? "NOTIFY" : value.present ? "PRESENT" : "MISS";
    node.querySelector(".source").textContent = value.lastSource || "n/a";
    node.querySelector(".raw").textContent = value.rawHex || "n/a";
    node.querySelector(".parsed").textContent = value.parsed ? compactParsed(value.parsed) : "{}";
    node.title = [
      value.uuid,
      `props=${(value.properties || []).join(",") || "n/a"}`,
      `updated=${value.lastUpdatedAt || "never"}`,
      value.parsed ? JSON.stringify(value.parsed, null, 2) : "{}"
    ].join("\n");
    els.values.appendChild(node);
  }
}

function renderLog() {
  els.log.innerHTML = "";
  for (const entry of state.logs || []) {
    const line = document.createElement("div");
    line.className = "log-entry";
    if (entry.kind === "error") line.classList.add("error");
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = shortTime(entry.at);
    const kind = document.createElement("span");
    kind.className = "log-kind";
    kind.textContent = entry.kind;
    const message = document.createElement("span");
    message.textContent = formatHexText(entry.message);
    line.append(time, kind, message);
    els.log.appendChild(line);
  }
}

async function post(url, body) {
  try {
    await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    alert(error.message);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = item[key];
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function shortTime(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function compactParsed(parsed) {
  const flattened = flatten(parsed);
  return Object.entries(flattened)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join("  ");
}

function flatten(value, prefix = "", out = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    out[prefix || "value"] = value;
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, next, out);
    } else {
      out[next] = child;
    }
  }
  return out;
}

function formatValue(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "");
  }
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  return formatHexText(value);
}

function formatIdentifier(value) {
  const text = String(value || "");
  return /^[0-9a-f]+$/i.test(text) ? text.toUpperCase() : text;
}

function formatAddress(value) {
  return String(value || "").toUpperCase();
}

function formatHexText(value) {
  return String(value)
    .replace(/\b0x[0-9a-f]+\b/gi, (match) => match.toUpperCase())
    .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, (match) => match.toUpperCase())
    .replace(/\b[0-9a-f]{4}\b/gi, (match) => match.toUpperCase());
}
