"use strict";

const root = document.getElementById("aircos");
const template = document.getElementById("aircoTemplate");
const summary = document.getElementById("summary");
const refreshAll = document.getElementById("refreshAll");
const EDIT_PAUSE_MS = 30000;
let pauseRefreshUntil = 0;

const modeByNumber = {
  0: "auto",
  1: "cool",
  2: "heat",
  3: "fan",
  4: "dry",
};

const airflowByNumber = {
  0: "auto",
  1: "lowest",
  2: "low",
  3: "high",
  4: "highest",
};

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
});

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function pauseRefresh(ms = EDIT_PAUSE_MS) {
  pauseRefreshUntil = Date.now() + ms;
}

function refreshPaused() {
  return Date.now() < pauseRefreshUntil;
}

function setText(card, field, value) {
  card.querySelector(`[data-field="${field}"]`).textContent = value ?? "-";
}

function setVisible(card, field, visible) {
  card.querySelectorAll(`[data-field="${field}"]`).forEach((element) => {
    element.classList.toggle("is-hidden", !visible);
  });
}

function setFormValue(card, name, value) {
  const input = card.querySelector(`[name="${name}"]`);
  if (!input || value === undefined || value === null) return;
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = value;
}

function setControlsDisabled(card, disabled) {
  card.querySelectorAll("button, input, select").forEach((element) => {
    element.disabled = disabled;
  });
}

function secondsSince(value) {
  if (!value) return "never";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return `${Math.max(0, Math.round((Date.now() - time) / 1000))}s ago`;
}

function sameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function formatLocalTime(value) {
  return timeFormatter.format(value);
}

function formatLocalDate(value) {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (sameLocalDay(value, now)) return "today";
  if (sameLocalDay(value, yesterday)) return "yesterday";
  return dateFormatter.format(value);
}

function formatWatts(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${Math.round(Number(value))} W`;
}

function formatKwh(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const fixed = Math.abs(Number(value)) < 10 ? Number(value).toFixed(2) : Number(value).toFixed(1);
  return `${fixed} kWh`;
}

function formatPowerHistory(history) {
  if (!history || history.powerState !== "on" || !history.powerChangedAt) return null;
  const changedAt = new Date(history.powerChangedAt);
  if (Number.isNaN(changedAt.getTime())) return null;
  return `${formatLocalDate(changedAt)}, ${formatLocalTime(changedAt)}`;
}

function syncControlAvailability(card) {
  const powerOn = card.querySelector('[data-action="power"][data-value="on"]');
  const entrustOn = card.querySelector('[data-action="entrust"][data-value="on"]');
  const windDirectionUD = card.querySelector('[name="windDirectionUD"]');
  const windDirectionLR = card.querySelector('[name="windDirectionLR"]');
  const poweredOff = !powerOn || !powerOn.classList.contains("active");
  const entrustActive = Boolean(entrustOn?.classList.contains("active"));
  const statusAvailable = card.dataset.hasStatus === "true";

  card.querySelectorAll("input, select").forEach((element) => {
    element.disabled = poweredOff;
  });

  card.querySelectorAll('button[data-action="entrust"], button[data-action="vacant-preset"]').forEach((button) => {
    button.disabled = poweredOff;
  });

  if (windDirectionUD) windDirectionUD.disabled = poweredOff || entrustActive;
  if (windDirectionLR) windDirectionLR.disabled = poweredOff || entrustActive;
  const savePreset = card.querySelector('[data-role="save-preset"]');
  if (savePreset) savePreset.disabled = !statusAvailable;
}

function syncSegmentState(card, action, value) {
  card.querySelectorAll(`[data-action="${action}"]`).forEach((button) => {
    const active = button.dataset.value === String(value);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function presetSummary(preset) {
  const settings = preset.settings;
  const details = [
    "Turns on",
    `${settings.temperature} °C`,
    settings.mode,
    `fan ${settings.airflow}`,
    `vertical vane ${settings.windDirectionUD}`,
    `horizontal vane ${settings.windDirectionLR}`,
    settings.entrust ? "3D auto on" : "3D auto off",
    settings.vacant ? "vacant on" : "vacant off",
  ];
  return details.join(" · ");
}

function renderPresets(card, item) {
  const list = card.querySelector('[data-role="preset-list"]');
  const presets = Array.isArray(item.presets) ? item.presets : [];
  if (presets.length === 0) {
    const empty = document.createElement("span");
    empty.className = "preset-empty";
    empty.textContent = "No presets saved for this air conditioner yet.";
    list.append(empty);
    return;
  }

  for (const preset of presets) {
    const group = document.createElement("span");
    group.className = "preset-item";

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "preset-apply";
    apply.textContent = preset.name;
    apply.title = `Apply ${preset.name}: ${presetSummary(preset)}`;
    apply.setAttribute("aria-label", `Apply preset ${preset.name}`);
    apply.addEventListener("click", () => applyPreset(card, preset));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "preset-remove";
    remove.innerHTML = `
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m5 5 10 10M15 5 5 15"></path>
      </svg>
    `;
    remove.title = `Delete ${preset.name} from this air conditioner`;
    remove.setAttribute("aria-label", `Delete preset ${preset.name}`);
    remove.addEventListener("click", () => deletePreset(card, preset));

    group.append(apply, remove);
    list.append(group);
  }
}

function renderAirco(item) {
  const card = template.content.firstElementChild.cloneNode(true);
  const airco = item.airco;
  const status = item.status || {};
  const badge = card.querySelector('[data-field="online"]');
  const mode = status.operationModeName || modeByNumber[status.operationMode] || "unknown";
  const airflow = status.airFlowName || airflowByNumber[status.airFlow] || "unknown";

  card.dataset.id = airco.id;
  card.dataset.hasStatus = String(Boolean(item.status));
  setText(card, "name", airco.name);
  setText(card, "footerId", airco.id);
  setText(card, "footerAddress", `${airco.ip}:${airco.port}`);
  setText(card, "footerUpdate", secondsSince(item.lastUpdate));
  const powerHistory = formatPowerHistory(item.history);
  setVisible(card, "powerHistory", Boolean(powerHistory));
  setText(card, "powerHistoryValue", powerHistory);
  setText(card, "indoor", status.indoorTemp == null ? "-" : `${status.indoorTemp} °C`);
  setText(card, "outdoor", status.outdoorTemp == null ? "-" : `${status.outdoorTemp} °C`);
  const electricKwh = status.electric ?? item.history?.lastElectricKwh;
  setText(card, "electricKwh", electricKwh == null ? "-" : `${Number(electricKwh).toFixed(2)} kWh`);
  setText(card, "electricWatts", formatWatts(item.history?.currentWatts));
  setText(card, "monthTotal", formatKwh(item.history?.monthTotalKwh));
  setText(card, "selfClean", status.isSelfCleanOperation ? "Active" : "Off");
  card.querySelector('[data-status="selfClean"]')
    ?.classList.toggle("is-active", Boolean(status.isSelfCleanOperation));
  const errorCode = String(status.errorCode || "").trim();
  const showErrorCode = errorCode && errorCode !== "00";
  setVisible(card, "errorCodeBox", showErrorCode);
  setText(card, "errorCode", showErrorCode ? errorCode : "");
  setText(card, "error", item.lastError ? item.lastError.message : "");

  badge.textContent = item.online ? "Online" : "Offline";
  badge.classList.toggle("offline", !item.online);
  badge.setAttribute("aria-label", item.online ? "Air conditioner online" : "Air conditioner offline");

  setFormValue(card, "temperature", status.presetTemp);
  setFormValue(card, "mode", mode);
  setFormValue(card, "airflow", airflow);
  setFormValue(card, "windDirectionUD", status.windDirectionUD);
  setFormValue(card, "windDirectionLR", status.windDirectionLR);
  syncSegmentState(card, "power", status.power || "off");
  syncSegmentState(card, "entrust", status.entrust ? "on" : "off");
  syncSegmentState(card, "vacant-preset", status.isVacantProperty ? "on" : "off");
  renderPresets(card, item);
  syncControlAvailability(card);

  card.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runCommand(card, button.dataset.action, button.dataset.value);
    });
  });

  card.querySelector('[data-role="delete"]').addEventListener("click", () => {
    openDeleteDialog(item);
  });

  const savePreset = card.querySelector('[data-role="save-preset"]');
  savePreset.addEventListener("click", () => openPresetDialog(item));

  card.querySelector('[name="temperature"]')?.addEventListener("change", async () => {
    await saveSettings(card);
  });

  card.querySelector('[name="mode"]')?.addEventListener("change", async () => {
    await saveSettings(card);
  });

  card.querySelector('[name="airflow"]')?.addEventListener("change", async () => {
    await saveSettings(card);
  });

  card.querySelector('[data-live-action="vane-ud"]')?.addEventListener("change", async () => {
    await applyLiveVane(card, "windDirectionUD");
  });

  card.querySelector('[data-live-action="vane-lr"]')?.addEventListener("change", async () => {
    await applyLiveVane(card, "windDirectionLR");
  });

  return card;
}

async function applyPreset(card, preset) {
  const id = encodeURIComponent(card.dataset.id);
  setControlsDisabled(card, true);
  try {
    await request(`/api/aircos/${id}/presets/${encodeURIComponent(preset.id)}/apply`, {
      method: "POST",
      body: "{}",
    });
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    setText(card, "error", err.message);
  } finally {
    setControlsDisabled(card, false);
    syncControlAvailability(card);
  }
}

async function deletePreset(card, preset) {
  if (!window.confirm(`Delete preset "${preset.name}" from this air conditioner?`)) return;
  const id = encodeURIComponent(card.dataset.id);
  setControlsDisabled(card, true);
  try {
    await request(`/api/aircos/${id}/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    setText(card, "error", err.message);
  } finally {
    setControlsDisabled(card, false);
    syncControlAvailability(card);
  }
}

async function runCommand(card, action, value) {
  const id = card.dataset.id;
  card.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    if (action === "refresh") {
      await request(`/api/aircos/${id}/refresh`, { method: "POST", body: "{}" });
    } else if (action === "power") {
      await request(`/api/aircos/${id}/power`, { method: "POST", body: JSON.stringify({ power: value }) });
    } else if (action === "entrust") {
      await request(`/api/aircos/${id}/entrust`, { method: "POST", body: JSON.stringify({ entrust: value }) });
    } else if (action === "vacant") {
      await request(`/api/aircos/${id}/vacant`, { method: "POST", body: JSON.stringify({ vacant: value }) });
    } else if (action === "vacant-preset") {
      await request(`/api/aircos/${id}/vacant-preset`, { method: "POST", body: JSON.stringify({ vacant: value }) });
    }
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    setText(card, "error", err.message);
  } finally {
    card.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function applyLiveVane(card, field) {
  const id = card.dataset.id;
  const body = {};
  body[field] = Number(card.querySelector(`[name="${field}"]`).value);

  setControlsDisabled(card, true);
  try {
    await request(`/api/aircos/${id}/vane`, { method: "POST", body: JSON.stringify(body) });
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    setText(card, "error", err.message);
  } finally {
    setControlsDisabled(card, false);
    syncControlAvailability(card);
  }
}

async function saveSettings(card) {
  const id = card.dataset.id;
  const body = {
    temperature: Number(card.querySelector('[name="temperature"]').value),
    mode: card.querySelector('[name="mode"]').value,
    airflow: card.querySelector('[name="airflow"]').value,
  };

  setControlsDisabled(card, true);
  try {
    await request(`/api/aircos/${id}/settings`, { method: "POST", body: JSON.stringify(body) });
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    setText(card, "error", err.message);
  } finally {
    setControlsDisabled(card, false);
    syncControlAvailability(card);
  }
}

function renderEmptyState() {
  const empty = document.createElement("section");
  empty.className = "empty-state";

  const content = document.createElement("div");
  content.className = "empty-state-content";

  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `
    <svg viewBox="0 0 32 32">
      <rect x="5" y="7" width="22" height="12" rx="3"></rect>
      <path d="M10 13h12M10 23c1.8-1.7 4.2-1.7 6 0s4.2 1.7 6 0"></path>
    </svg>
  `;

  const message = document.createElement("h2");
  message.textContent = "Your climate dashboard is ready";
  const hint = document.createElement("p");
  hint.textContent = "Connect your first air conditioner to control comfort settings and monitor live energy use.";

  const action = document.createElement("button");
  action.type = "button";
  action.innerHTML = `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4v12M4 10h12"></path>
    </svg>
    Add air conditioner
  `;
  action.addEventListener("click", () => addAirco.click());

  content.append(icon, message, hint, action);
  empty.append(content);
  return empty;
}

async function load({ force = false } = {}) {
  if (!force && refreshPaused()) return;
  const data = await request("/api/aircos");
  if (data.aircos.length === 0) {
    root.replaceChildren(renderEmptyState());
    summary.textContent = "No air conditioners";
    return;
  }
  root.replaceChildren(...data.aircos.map(renderAirco));
  const online = data.aircos.filter((item) => item.online).length;
  summary.textContent = `${online}/${data.aircos.length} online`;
}

root.addEventListener("focusin", () => pauseRefresh());
root.addEventListener("input", () => pauseRefresh());
root.addEventListener("change", () => pauseRefresh());

// ---------------------------------------------------------------------------
// Air conditioner setup wizard
// ---------------------------------------------------------------------------

const wizard = document.getElementById("wizard");
const wizardForm = wizard.querySelector(".wizard-form");
const addAirco = document.getElementById("addAirco");

const wizardState = {
  step: "connect",
  ip: "",
  port: 51443,
  discoveryId: null,
  probed: null,
  identity: null,
  registeredHere: false,
  saved: false,
  busy: false,
  discoveryGeneration: 0,
};

const STEP_ORDER = ["connect", "credentials", "test", "name", "done"];

function wizardEl(name) {
  return wizard.querySelector(`[data-wizard="${name}"]`);
}

function wizardInput(name) {
  return wizard.querySelector(`[name="${name}"]`);
}

function wizardError(message) {
  wizardEl("error").textContent = message || "";
}

function friendlyError(err) {
  const message = err?.message || String(err);
  if (/fetch|network/i.test(message)) return "Cannot reach the bridge. Check your network connection.";
  if (/timeout|ETIMEDOUT|EHOSTUNREACH|ECONNREFUSED|ENETUNREACH/i.test(message)) {
    return "No unit found at this address. Check the IP address and make sure the unit is on the same network.";
  }
  if (/operator list is full/i.test(message)) {
    return "The unit has no free account slots left (maximum four). Remove an unused account in the Smart M-Air app and try again.";
  }
  return message;
}

function setWizardBusy(busy, label) {
  wizardState.busy = busy;
  const next = wizardEl("next");
  next.disabled = busy;
  wizardEl("back").disabled = busy;
  next.textContent = busy ? (label || "Working...") : nextLabelForStep(wizardState.step);
}

function nextLabelForStep(step) {
  if (step === "connect") return "Find unit";
  if (step === "name") return "Add";
  if (step === "done") return "Close";
  return "Continue";
}

function showWizardStep(step) {
  wizardState.step = step;
  wizardError("");
  wizard.querySelectorAll("[data-step]").forEach((section) => {
    section.classList.toggle("is-hidden", section.dataset.step !== step);
  });
  const reached = STEP_ORDER.indexOf(step);
  wizard.querySelectorAll("[data-step-dot]").forEach((dot) => {
    const index = STEP_ORDER.indexOf(dot.dataset.stepDot);
    dot.classList.toggle("active", index === reached);
    dot.classList.toggle("completed", index < reached);
  });
  wizardEl("back").classList.toggle("is-hidden", step === "connect" || step === "done");
  wizardEl("cancel").classList.toggle("is-hidden", step === "done");
  wizardEl("next").textContent = nextLabelForStep(step);

  if (step === "connect") wizardInput("wizardIp").focus();
  if (step === "name") wizardInput("wizardName").focus();
}

function resetWizard() {
  wizardState.discoveryGeneration += 1;
  wizardState.ip = "";
  wizardState.port = 51443;
  wizardState.discoveryId = null;
  wizardState.probed = null;
  wizardState.identity = null;
  wizardState.registeredHere = false;
  wizardState.saved = false;
  wizardState.busy = false;
  wizardForm.reset();
  wizardEl("discovered").replaceChildren();
  wizardEl("discovered").classList.add("is-hidden");
  wizardEl("discoveryStatus").textContent = "Searching via mDNS...";
  wizardEl("scan").disabled = false;
  wizardEl("found").classList.add("is-hidden");
  wizardEl("reuseFields").classList.add("is-hidden");
  wizardEl("testResult").classList.add("is-hidden");
  setWizardBusy(false);
  showWizardStep("connect");
}

function selectDiscoveredUnit(unit, radio) {
  if (unit.configured) return;
  radio.checked = true;
  wizardInput("wizardIp").value = unit.ip;
  wizardInput("wizardPort").value = unit.port;
  wizardState.discoveryId = unit.discoveryId;
  wizardEl("found").classList.add("is-hidden");
  wizardError("");
}

function renderDiscoveredUnits(units) {
  const container = wizardEl("discovered");
  const available = units.filter((unit) => !unit.configured);
  const choices = units.map((unit, index) => {
    const label = document.createElement("label");
    label.className = "choice";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "discoveredUnit";
    radio.value = String(index);
    radio.dataset.ip = unit.ip;
    radio.dataset.port = String(unit.port);
    radio.dataset.discoveryId = unit.discoveryId;
    radio.disabled = Boolean(unit.configured);
    radio.addEventListener("change", () => selectDiscoveredUnit(unit, radio));

    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = unit.name || "Mitsubishi WF-RAC";
    const address = document.createElement("small");
    address.textContent = `${unit.ip}:${unit.port}${unit.configured ? " · Already added" : ""}`;
    copy.append(name, address);
    label.append(radio, copy);
    return label;
  });

  container.replaceChildren(...choices);
  container.classList.toggle("is-hidden", choices.length === 0);
  wizardEl("discoveryStatus").textContent = units.length === 0
    ? "No air conditioners found via mDNS."
    : `${units.length} air conditioner${units.length === 1 ? "" : "s"} found via mDNS.`;

  const selectedAddress = [...container.querySelectorAll("input:not(:disabled)")].find((radio) => (
    radio.dataset.ip === wizardInput("wizardIp").value.trim()
      && radio.dataset.port === wizardInput("wizardPort").value
  ));
  if (selectedAddress) {
    selectedAddress.checked = true;
    wizardState.discoveryId = selectedAddress.dataset.discoveryId;
  } else {
    wizardState.discoveryId = null;
  }
  if (!selectedAddress && !wizardInput("wizardIp").value && available.length === 1) {
    const index = units.indexOf(available[0]);
    selectDiscoveredUnit(available[0], container.querySelector(`input[value="${index}"]`));
  }
}

async function discoverWizardUnits() {
  const generation = ++wizardState.discoveryGeneration;
  const scan = wizardEl("scan");
  scan.disabled = true;
  scan.textContent = "Scanning...";
  wizardEl("discoveryStatus").textContent = "Searching via mDNS...";

  try {
    const result = await request("/api/setup/discover");
    if (generation !== wizardState.discoveryGeneration || !wizard.open) return;
    if (result.disabled) {
      wizardEl("discoveryStatus").textContent = "Automatic discovery is disabled; enter the address manually.";
      return;
    }
    renderDiscoveredUnits(result.units || []);
  } catch {
    if (generation === wizardState.discoveryGeneration && wizard.open) {
      wizardEl("discoveryStatus").textContent = "Automatic discovery is unavailable; enter the address manually.";
    }
  } finally {
    if (generation === wizardState.discoveryGeneration) {
      scan.disabled = false;
      scan.textContent = "Scan again";
    }
  }
}

async function cleanupUnsavedRegistration() {
  if (!wizardState.registeredHere || wizardState.saved || !wizardState.identity) return;
  const identity = wizardState.identity;
  wizardState.registeredHere = false;
  try {
    await request("/api/setup/unregister", {
      method: "POST",
      body: JSON.stringify({ ip: wizardState.ip, port: wizardState.port, ...identity }),
    });
  } catch {
    // Best effort: leaving an unused account behind is harmless.
  }
}

function closeWizard() {
  cleanupUnsavedRegistration();
  wizard.close();
}

async function wizardConnect() {
  const ip = wizardInput("wizardIp").value.trim();
  const port = Number(wizardInput("wizardPort").value) || 51443;
  if (!ip) {
    wizardError("Enter an IP address.");
    wizardInput("wizardIp").focus();
    return;
  }

  setWizardBusy(true, "Searching...");
  try {
    const info = await request("/api/setup/probe", {
      method: "POST",
      body: JSON.stringify({ ip, port }),
    });
    wizardState.ip = ip;
    wizardState.port = port;
    wizardState.probed = info;
    const found = wizardEl("found");
    found.textContent = `Unit found (MAC ${info.macAddress || info.airconId || "unknown"})`;
    found.classList.remove("is-hidden");
    showWizardStep("credentials");
  } catch (err) {
    wizardError(friendlyError(err));
  } finally {
    setWizardBusy(false);
  }
}

async function wizardCredentials() {
  const mode = wizard.querySelector('[name="credMode"]:checked').value;

  if (mode === "register") {
    setWizardBusy(true, "Registering...");
    try {
      const identity = await request("/api/setup/register", {
        method: "POST",
        body: JSON.stringify({ ip: wizardState.ip, port: wizardState.port }),
      });
      wizardState.identity = {
        deviceId: identity.deviceId,
        operatorId: identity.operatorId,
        airconId: identity.airconId,
      };
      wizardState.registeredHere = true;
    } catch (err) {
      wizardError(friendlyError(err));
      return;
    } finally {
      setWizardBusy(false);
    }
  } else {
    const deviceId = wizardInput("wizardDeviceId").value.trim();
    const operatorId = wizardInput("wizardOperatorId").value.trim();
    if (!deviceId || !operatorId) {
      wizardError("Enter both a Device ID and an Operator ID.");
      return;
    }
    wizardState.identity = {
      deviceId,
      operatorId,
      airconId: wizardState.probed?.airconId || "1",
    };
    wizardState.registeredHere = false;
  }

  showWizardStep("test");
  runWizardTest();
}

async function runWizardTest() {
  const busyEl = wizardEl("testBusy");
  const resultEl = wizardEl("testResult");
  busyEl.classList.remove("is-hidden");
  resultEl.classList.add("is-hidden");
  setWizardBusy(true, "Testing...");

  try {
    const { status } = await request("/api/setup/test", {
      method: "POST",
      body: JSON.stringify({ ip: wizardState.ip, port: wizardState.port, ...wizardState.identity }),
    });
    const parts = [
      `Power: ${status.operation ? "on" : "off"}`,
      status.indoorTemp == null ? null : `Indoor: ${status.indoorTemp} °C`,
      status.outdoorTemp == null ? null : `Outdoor: ${status.outdoorTemp} °C`,
    ].filter(Boolean);
    resultEl.textContent = `Connection works. ${parts.join(" · ")}`;
    resultEl.classList.remove("is-hidden");
    showWizardStep("name");
  } catch (err) {
    wizardError(friendlyError(err));
    showWizardStep("credentials");
  } finally {
    busyEl.classList.add("is-hidden");
    setWizardBusy(false);
  }
}

async function wizardSave() {
  const name = wizardInput("wizardName").value.trim();
  if (!name) {
    wizardError("Enter a name for the unit.");
    wizardInput("wizardName").focus();
    return;
  }

  setWizardBusy(true, "Adding...");
  try {
    const snapshot = await request("/api/aircos", {
      method: "POST",
      body: JSON.stringify({
        name,
        ip: wizardState.ip,
        port: wizardState.port,
        discoveryId: wizardState.discoveryId,
        ...wizardState.identity,
      }),
    });
    wizardState.saved = true;
    wizardEl("doneResult").textContent = `"${snapshot.airco.name}" was added and will now refresh every ${Math.round(snapshot.airco.pollIntervalMs / 1000)} seconds.`;
    showWizardStep("done");
    pauseRefreshUntil = 0;
    load({ force: true }).catch(() => {});
  } catch (err) {
    wizardError(friendlyError(err));
  } finally {
    setWizardBusy(false);
  }
}

wizardEl("next").addEventListener("click", () => {
  if (wizardState.busy) return;
  if (wizardState.step === "connect") wizardConnect();
  else if (wizardState.step === "credentials") wizardCredentials();
  else if (wizardState.step === "test") runWizardTest();
  else if (wizardState.step === "name") wizardSave();
  else if (wizardState.step === "done") wizard.close();
});

wizardEl("back").addEventListener("click", () => {
  if (wizardState.busy) return;
  if (wizardState.step === "credentials") showWizardStep("connect");
  else if (wizardState.step === "test" || wizardState.step === "name") showWizardStep("credentials");
});

wizardEl("cancel").addEventListener("click", closeWizard);
wizardEl("close").addEventListener("click", closeWizard);

wizard.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeWizard();
});

wizardForm.addEventListener("submit", (event) => event.preventDefault());

wizardForm.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.tagName === "INPUT") {
    event.preventDefault();
    wizardEl("next").click();
  }
});

wizard.querySelectorAll('[name="credMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    wizardEl("reuseFields").classList.toggle("is-hidden", radio.value !== "reuse" || !radio.checked);
  });
});

wizardEl("scan").addEventListener("click", discoverWizardUnits);

function clearMismatchedDiscoverySelection() {
  const selected = wizard.querySelector('[name="discoveredUnit"]:checked');
  if (!selected) return;
  const matches = selected.dataset.ip === wizardInput("wizardIp").value.trim()
    && selected.dataset.port === wizardInput("wizardPort").value;
  if (!matches) {
    selected.checked = false;
    wizardState.discoveryId = null;
  }
}

wizardInput("wizardIp").addEventListener("input", clearMismatchedDiscoverySelection);
wizardInput("wizardPort").addEventListener("input", clearMismatchedDiscoverySelection);

addAirco.addEventListener("click", () => {
  resetWizard();
  wizard.showModal();
  discoverWizardUnits();
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const presetDialog = document.getElementById("presetDialog");
const presetForm = presetDialog.querySelector('[data-preset="form"]');
let presetTargetId = null;
let presetBusy = false;

function presetEl(name) {
  return presetDialog.querySelector(`[data-preset="${name}"]`);
}

function openPresetDialog(item) {
  presetTargetId = item.airco.id;
  presetBusy = false;
  presetForm.reset();
  presetEl("source").textContent = `Save the current settings from ${item.airco.name}.`;
  presetEl("error").textContent = "";
  presetEl("save").disabled = false;
  presetEl("save").textContent = "Save preset";
  presetDialog.showModal();
  presetForm.elements.presetName.focus();
}

function closePresetDialog() {
  if (!presetBusy) presetDialog.close();
}

async function savePreset(event) {
  event.preventDefault();
  if (presetBusy || !presetTargetId) return;

  const name = presetForm.elements.presetName.value.trim();
  if (!name) {
    presetEl("error").textContent = "Enter a preset name.";
    presetForm.elements.presetName.focus();
    return;
  }

  presetBusy = true;
  presetEl("error").textContent = "";
  presetEl("save").disabled = true;
  presetEl("save").textContent = "Saving...";

  try {
    await request(`/api/aircos/${encodeURIComponent(presetTargetId)}/presets`, {
      method: "POST",
      body: JSON.stringify({
        name,
        global: presetForm.elements.presetGlobal.checked,
      }),
    });
    presetDialog.close();
    pauseRefreshUntil = 0;
    await load({ force: true });
  } catch (err) {
    presetEl("error").textContent = friendlyError(err);
  } finally {
    presetBusy = false;
    presetEl("save").disabled = false;
    presetEl("save").textContent = "Save preset";
  }
}

presetForm.addEventListener("submit", savePreset);
presetEl("cancel").addEventListener("click", closePresetDialog);
presetEl("close").addEventListener("click", closePresetDialog);
presetDialog.addEventListener("cancel", (event) => {
  if (presetBusy) event.preventDefault();
});
presetDialog.addEventListener("close", () => {
  presetTargetId = null;
  presetBusy = false;
});

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

const confirmDialog = document.getElementById("confirmDelete");
let deleteTargetId = null;
let deleteBusy = false;

function confirmEl(name) {
  return confirmDialog.querySelector(`[data-confirm="${name}"]`);
}

function openDeleteDialog(item) {
  deleteTargetId = item.airco.id;
  deleteBusy = false;
  confirmEl("text").textContent = `Delete "${item.airco.name}"?`;
  confirmEl("error").textContent = "";
  const willDeleteAccount = item.airco.bridgeManagedIdentity && !item.airco.identityShared;
  confirmEl("note").textContent = willDeleteAccount
    ? "Stored usage history and presets will also be deleted, and the account created by the bridge will be removed from the unit."
    : "Stored usage history and presets will also be deleted. The account on the unit will remain.";
  confirmEl("note").classList.remove("is-hidden");
  const deleteButton = confirmEl("delete");
  deleteButton.disabled = false;
  deleteButton.textContent = "Delete";
  confirmEl("cancel").textContent = "Cancel";
  confirmDialog.showModal();
}

async function performDelete() {
  if (deleteBusy || !deleteTargetId) return;
  deleteBusy = true;
  const deleteButton = confirmEl("delete");
  deleteButton.disabled = true;
  deleteButton.textContent = "Deleting...";
  confirmEl("error").textContent = "";

  try {
    const result = await request(`/api/aircos/${deleteTargetId}`, { method: "DELETE" });
    deleteTargetId = null;
    pauseRefreshUntil = 0;
    load({ force: true }).catch(() => {});

    if (result.accountDeleted === false) {
      confirmEl("text").textContent = "The unit was deleted.";
      confirmEl("note").classList.add("is-hidden");
      confirmEl("error").textContent =
        "The bridge account could not be removed from the unit. You can clean it up in the Smart M-Air app if needed.";
      deleteButton.classList.add("is-hidden");
      confirmEl("cancel").textContent = "Close";
      deleteBusy = false;
      return;
    }

    confirmDialog.close();
  } catch (err) {
    confirmEl("error").textContent = friendlyError(err);
    deleteButton.disabled = false;
    deleteButton.textContent = "Delete";
    deleteBusy = false;
  }
}

confirmEl("delete").addEventListener("click", performDelete);
confirmEl("cancel").addEventListener("click", () => confirmDialog.close());
confirmEl("close").addEventListener("click", () => confirmDialog.close());
confirmDialog.addEventListener("close", () => {
  deleteTargetId = null;
  deleteBusy = false;
  confirmEl("delete").classList.remove("is-hidden");
});

refreshAll.addEventListener("click", () => load({ force: true }));
load({ force: true }).catch((err) => {
  summary.textContent = err.message;
});

setInterval(() => {
  load().catch(() => {});
}, 10000);
