"use strict";

const automationPage = document.getElementById("automations");
const aircoPage = document.getElementById("aircos");
const automationList = document.getElementById("automationList");
const automationFlowPicker = document.getElementById("automationFlowPicker");
const automationPickerName = document.getElementById("automationPickerName");
const automationPickerStatus = document.getElementById("automationPickerStatus");
const automationPickerCount = document.getElementById("automationPickerCount");
const automationEmpty = document.getElementById("automationEmpty");
const automationEditor = document.getElementById("automationEditor");
const automationCanvas = document.getElementById("automationCanvas");
const automationViewport = document.getElementById("automationCanvasViewport");
const automationNodes = document.getElementById("automationNodes");
const automationConnections = document.getElementById("automationConnections");
const automationCanvasHint = document.getElementById("automationCanvasHint");
const automationPaletteDock = document.getElementById("automationPaletteDock");
const automationPalette = document.getElementById("automationPalette");
const automationPaletteToggle = document.getElementById("automationPaletteToggle");
const automationName = document.getElementById("automationName");
const automationEnabled = document.getElementById("automationEnabled");
const automationStatus = document.getElementById("automationStatus");
const automationHelp = document.getElementById("automationHelp");
const saveAutomationButton = document.getElementById("saveAutomation");
const deleteAutomationButton = document.getElementById("deleteAutomation");
const automationActivity = document.getElementById("automationActivity");
const automationActivityList = document.getElementById("automationActivityList");
const automationActivitySummary = document.getElementById("automationActivitySummary");
const refreshAutomationActivity = document.getElementById("refreshAutomationActivity");
const clearAutomationActivity = document.getElementById("clearAutomationActivity");
const shortcutDialog = document.getElementById("temperatureShortcutDialog");
const shortcutForm = shortcutDialog.querySelector('[data-shortcut="form"]');
const SVG_NS = "http://www.w3.org/2000/svg";
const CANVAS_MIN_WIDTH = 1250;
const CANVAS_MIN_HEIGHT = 1050;
const CANVAS_RIGHT_SPACE = 430;
const CANVAS_BOTTOM_SPACE = 300;

const activityTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const activityDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const CONDITION_TYPES = new Set(["temperature", "power", "mode", "time"]);
const LOGIC_TYPES = new Set(["and", "or"]);
const ACTION_TYPES = new Set(["apply-preset", "set-power"]);
const NODE_META = {
  temperature: { title: "Temperature", icon: "🌡", kind: "condition" },
  power: { title: "Power state", icon: "◉", kind: "condition" },
  mode: { title: "Operating mode", icon: "◎", kind: "condition" },
  time: { title: "Time window", icon: "◷", kind: "condition" },
  and: { title: "AND", icon: "EN", kind: "logic" },
  or: { title: "OR", icon: "OF", kind: "logic" },
  "apply-preset": { title: "Start preset", icon: "❄", kind: "action" },
  "set-power": { title: "Set power", icon: "⏻", kind: "action" },
};

const automationState = {
  view: "aircos",
  automations: [],
  aircos: [],
  selectedId: null,
  draft: null,
  dirty: false,
  busy: false,
  pendingConnection: null,
  connectionDrag: null,
  nodeDrag: null,
  canvasPan: null,
  paletteOffset: 0,
  activity: [],
  renderedCanvasId: null,
};

function automationId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function labeledControl(labelText, control) {
  const label = document.createElement("label");
  label.append(el("span", "", labelText), control);
  return label;
}

function automationError(err) {
  return typeof friendlyError === "function" ? friendlyError(err) : (err?.message || String(err));
}

function selectedAutomation() {
  return automationState.automations.find((automation) => automation.id === automationState.selectedId) || null;
}

function aircoItem(id) {
  return automationState.aircos.find((item) => item.airco.id === id) || null;
}

function firstAircoId() {
  return automationState.aircos[0]?.airco.id || "";
}

function presetsForAirco(id) {
  return aircoItem(id)?.presets || [];
}

function statusLabel(status) {
  return {
    active: "Active",
    idle: "Idle",
    waiting: "Waiting",
    invalid: "Incomplete",
    error: "Error",
    disabled: "Disabled",
    overridden: "Manual",
  }[status] || "Waiting";
}

function setAutomationPaletteOpen(open) {
  const nextOpen = Boolean(open);
  automationPalette.classList.toggle("is-hidden", !nextOpen);
  automationPaletteDock.classList.toggle("is-open", nextOpen);
  automationPaletteToggle.setAttribute("aria-expanded", String(nextOpen));
  automationPaletteToggle.setAttribute("aria-label", nextOpen ? "Close automation library" : "Add to automation");
  automationPaletteToggle.title = nextOpen
    ? "Close automation library"
    : "Add blocks or create from a template. Drag between dots to connect blocks; click a line to remove it.";
}

function setAutomationHelp(message = "") {
  automationHelp.textContent = message;
  automationHelp.classList.toggle("is-hidden", !message);
}

function switchMainView(view, { updateHash = true } = {}) {
  automationState.view = view;
  const showAutomations = view === "automations";
  automationPage.classList.toggle("is-hidden", !showAutomations);
  aircoPage.classList.toggle("is-hidden", showAutomations);
  document.querySelector('[data-view-actions="aircos"]').classList.toggle("is-hidden", showAutomations);
  document.querySelector('[data-view-actions="automations"]').classList.toggle("is-hidden", !showAutomations);
  document.getElementById("showAircos").classList.toggle("active", !showAutomations);
  document.getElementById("showAutomations").classList.toggle("active", showAutomations);
  document.getElementById("showAircos").setAttribute("aria-pressed", String(!showAutomations));
  document.getElementById("showAutomations").setAttribute("aria-pressed", String(showAutomations));
  if (!showAutomations) {
    automationFlowPicker.open = false;
    setAutomationPaletteOpen(false);
  }
  if (updateHash) history.replaceState(null, "", showAutomations ? "#automations" : location.pathname + location.search);
  if (showAutomations) loadAutomationData().catch(showAutomationLoadError);
}

function showAutomationLoadError(err) {
  automationEmpty.classList.remove("is-hidden");
  automationEditor.classList.add("is-hidden");
  automationEmpty.querySelector("h2").textContent = "Automations could not be loaded";
  automationEmpty.querySelector("p").textContent = automationError(err);
}

function markAutomationDirty(message = "Unsaved changes") {
  automationState.dirty = true;
  saveAutomationButton.textContent = "Save changes";
  setAutomationHelp(message);
}

function clearAutomationDirty() {
  automationState.dirty = false;
  saveAutomationButton.textContent = "Save flow";
  setAutomationHelp();
}

function renderAutomationList() {
  const selected = selectedAutomation();
  const selectedStatus = selected?.enabled ? (selected.runtime?.status || "waiting") : "disabled";
  automationPickerName.textContent = selected?.name || "No saved flows";
  automationPickerName.title = selected?.name || "";
  automationPickerStatus.classList.toggle("is-hidden", !selected);
  if (selected) automationPickerStatus.dataset.status = selectedStatus;
  automationPickerCount.textContent = `${automationState.automations.length} flow${automationState.automations.length === 1 ? "" : "s"}`;

  const items = automationState.automations.map((automation) => {
    const button = el("button", "automation-list-item");
    button.type = "button";
    button.classList.toggle("active", automation.id === automationState.selectedId);
    button.setAttribute("aria-current", automation.id === automationState.selectedId ? "true" : "false");
    const dot = el("span", "automation-state-dot");
    dot.dataset.status = automation.enabled ? (automation.runtime?.status || "waiting") : "disabled";
    const copy = el("span", "automation-list-copy");
    copy.append(
      el("strong", "", automation.name),
      el("small", "", automation.enabled ? statusLabel(automation.runtime?.status) : "Disabled")
    );
    button.append(dot, copy);
    button.addEventListener("click", () => {
      selectAutomation(automation.id);
      if (automationState.selectedId === automation.id) automationFlowPicker.open = false;
    });
    return button;
  });
  automationList.replaceChildren(...(items.length > 0
    ? items
    : [el("p", "automation-list-empty", "No flows saved yet.")]));
}

function activityTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "", time: "" };
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return { date: sameDay ? "Today" : activityDateFormatter.format(date), time: activityTimeFormatter.format(date) };
}

function renderAutomationActivity() {
  const entries = automationState.activity;
  if (entries.length === 0) {
    automationActivityList.replaceChildren(el("p", "automation-activity-empty", "No automation activity recorded yet."));
    automationActivitySummary.textContent = "No recorded events";
    return;
  }

  const rows = entries.map((entry) => {
    const row = el("article", "automation-activity-entry");
    row.dataset.level = entry.level || "info";
    const timestamp = activityTime(entry.time);
    const time = el("time", "automation-activity-time");
    time.dateTime = entry.time;
    time.append(document.createTextNode(timestamp.date), document.createElement("br"), document.createTextNode(timestamp.time));
    const marker = el("span", "automation-activity-marker");
    const copy = el("div", "automation-activity-copy");
    const title = el("span");
    title.append(el("strong", "", entry.title), el("span", "automation-activity-flow", entry.automationName));
    copy.append(title);
    if (entry.message && entry.message !== entry.title) copy.append(el("p", "", entry.message));
    const matchingReasons = (entry.conditions || []).filter((condition) => condition.result === true);
    if (matchingReasons.length > 0) {
      copy.append(el("p", "automation-activity-reason", matchingReasons.map((condition) => condition.message).join(" · ")));
    }
    row.append(time, marker, copy);
    return row;
  });
  automationActivityList.replaceChildren(...rows);
  const latest = activityTime(entries[0].time);
  automationActivitySummary.textContent = `${entries.length} recent event${entries.length === 1 ? "" : "s"} · latest ${latest.time}`;
}

async function loadAutomationActivity() {
  const data = await request("/api/automation-log?limit=100");
  automationState.activity = data.entries || [];
  renderAutomationActivity();
}

async function clearAutomationActivityLog() {
  if (!window.confirm("Clear the complete automation activity log?")) return;
  clearAutomationActivity.disabled = true;
  try {
    await request("/api/automation-log", { method: "DELETE" });
    automationState.activity = [];
    renderAutomationActivity();
  } catch (err) {
    automationActivitySummary.textContent = automationError(err);
  } finally {
    clearAutomationActivity.disabled = false;
  }
}

function selectAutomation(id, { discard = false } = {}) {
  if (id === automationState.selectedId && automationState.draft) return;
  if (automationState.dirty && !discard && !window.confirm("Discard the unsaved changes to this flow?")) return;
  const automation = automationState.automations.find((candidate) => candidate.id === id);
  automationState.selectedId = automation?.id || null;
  automationState.draft = automation ? cloneValue(automation) : null;
  automationState.pendingConnection = null;
  setAutomationPaletteOpen(false);
  clearAutomationDirty();
  renderAutomationList();
  renderAutomationEditor();
}

async function loadAutomationData({ selectId = null, force = false } = {}) {
  if (automationState.dirty && !force) return;
  const [automationData, aircoData] = await Promise.all([
    request("/api/automations"),
    request("/api/aircos"),
  ]);
  automationState.automations = automationData.automations || [];
  automationState.aircos = aircoData.aircos || [];
  const nextId = selectId
    || (automationState.automations.some((automation) => automation.id === automationState.selectedId)
      ? automationState.selectedId
      : automationState.automations[0]?.id);
  automationState.selectedId = nextId || null;
  automationState.draft = nextId
    ? cloneValue(automationState.automations.find((automation) => automation.id === nextId))
    : null;
  clearAutomationDirty();
  renderAutomationList();
  renderAutomationEditor();
  if (automationActivity.open) loadAutomationActivity().catch(() => {});
}

function renderAutomationEditor() {
  const draft = automationState.draft;
  automationEmpty.classList.toggle("is-hidden", Boolean(draft));
  automationEditor.classList.toggle("is-hidden", !draft);
  if (!draft) {
    automationState.renderedCanvasId = null;
    return;
  }

  automationName.value = draft.name;
  automationEnabled.checked = draft.enabled;
  const status = draft.enabled ? (draft.runtime?.status || "waiting") : "disabled";
  automationStatus.dataset.status = status;
  automationStatus.textContent = statusLabel(status);
  automationStatus.title = draft.runtime?.message || "";
  if (automationState.renderedCanvasId !== draft.id) {
    automationState.renderedCanvasId = draft.id;
    automationCanvas.style.width = "";
    automationCanvas.style.height = "";
    automationViewport.scrollLeft = 0;
    automationViewport.scrollTop = 0;
  }
  renderAutomationCanvas();
}

function currentNodeMessage(node) {
  if (automationState.dirty) return { result: "pending", message: "Save to evaluate" };
  const runtime = automationState.draft?.runtime;
  const nodeState = runtime?.nodeStates?.[node.id];
  const actionState = runtime?.actionStates?.[node.id];
  const state = actionState || nodeState;
  if (state?.lastError) return { result: "error", message: state.lastError.message };
  if (state) return { result: String(state.result), message: state.message || "Evaluated" };

  const item = aircoItem(node.config.aircoId);
  if (node.type === "temperature") {
    const value = item?.status?.[node.config.sensor === "indoor" ? "indoorTemp" : "outdoorTemp"];
    return { result: "pending", message: value == null ? "No current reading" : `Now ${value} °C` };
  }
  if (node.type === "power") return { result: "pending", message: `Now ${item?.status?.power || "unknown"}` };
  return { result: "pending", message: "Waiting for evaluation" };
}

function aircoSelect(value, onChange) {
  const select = document.createElement("select");
  for (const item of automationState.aircos) select.append(option(item.airco.id, item.airco.name));
  if (value && !automationState.aircos.some((item) => item.airco.id === value)) {
    select.append(option(value, `Missing: ${value}`));
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function simpleSelect(options, value, onChange) {
  const select = document.createElement("select");
  for (const [optionValue, label] of options) select.append(option(optionValue, label));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function numberInput(value, onChange, { min = -40, max = 60, step = 0.5 } = {}) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = value;
  input.addEventListener("change", () => onChange(Number(input.value)));
  return input;
}

function updateNode(node, patch, { rerender = false } = {}) {
  Object.assign(node.config, patch);
  markAutomationDirty();
  if (rerender) renderAutomationCanvas();
}

function temperatureBody(node) {
  const fragment = document.createDocumentFragment();
  fragment.append(labeledControl("Air conditioner", aircoSelect(node.config.aircoId, (value) => {
    updateNode(node, { aircoId: value }, { rerender: true });
  })));
  const row = el("div", "automation-node-row");
  row.append(
    labeledControl("Sensor", simpleSelect([
      ["indoor", "Indoor"], ["outdoor", "Outdoor"],
    ], node.config.sensor, (value) => updateNode(node, { sensor: value }))),
    labeledControl("Comparison", simpleSelect([
      ["gt", "> higher than"], ["gte", "≥ at least"], ["lt", "< lower than"], ["lte", "≤ at most"],
    ], node.config.operator, (value) => updateNode(node, { operator: value })))
  );
  fragment.append(row, labeledControl("Temperature °C", numberInput(node.config.value, (value) => updateNode(node, { value }))));
  return fragment;
}

function powerBody(node) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    labeledControl("Air conditioner", aircoSelect(node.config.aircoId, (value) => updateNode(node, { aircoId: value }, { rerender: true }))),
    labeledControl("Must be", simpleSelect([["off", "Off"], ["on", "On"]], node.config.state, (value) => updateNode(node, { state: value }))),
    labeledControl("For at least (minutes)", numberInput(
      node.config.durationMinutes ?? 0,
      (durationMinutes) => updateNode(node, { durationMinutes }),
      { min: 0, max: 10080, step: 1 }
    ))
  );
  return fragment;
}

function modeBody(node) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    labeledControl("Air conditioner", aircoSelect(node.config.aircoId, (value) => updateNode(node, { aircoId: value }, { rerender: true }))),
    labeledControl("Must be", simpleSelect([
      ["cool", "Cool"],
      ["fan", "Fan"],
      ["dry", "Dry"],
      ["heat", "Heat"],
      ["auto", "Auto"],
    ], node.config.mode, (value) => updateNode(node, { mode: value })))
  );
  return fragment;
}

function timeBody(node) {
  const fragment = document.createDocumentFragment();
  const row = el("div", "automation-node-row");
  const start = document.createElement("input");
  start.type = "time";
  start.value = node.config.start;
  start.addEventListener("change", () => updateNode(node, { start: start.value }));
  const end = document.createElement("input");
  end.type = "time";
  end.value = node.config.end;
  end.addEventListener("change", () => updateNode(node, { end: end.value }));
  row.append(labeledControl("From", start), labeledControl("Until", end));
  const days = el("div", "automation-weekdays");
  for (const [day, labelText] of [[1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [0, "S"]]) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = node.config.days.includes(day);
    checkbox.addEventListener("change", () => {
      const selected = [...days.querySelectorAll("input")]
        .filter((input) => input.checked)
        .map((input) => Number(input.value));
      if (selected.length === 0) {
        checkbox.checked = true;
        return;
      }
      updateNode(node, { days: selected });
    });
    checkbox.value = day;
    label.append(checkbox, document.createTextNode(labelText));
    days.append(label);
  }
  fragment.append(row, labeledControl("Days", days));
  return fragment;
}

function logicBody(node) {
  return el("p", "automation-node-summary", node.type === "and"
    ? "Every connected condition must match before the action runs."
    : "The action runs when at least one connected condition matches.");
}

function presetBody(node) {
  const fragment = document.createDocumentFragment();
  const unitSelect = aircoSelect(node.config.aircoId, (value) => {
    const firstPreset = presetsForAirco(value)[0];
    updateNode(node, { aircoId: value, presetId: firstPreset?.id || "missing-preset" }, { rerender: true });
  });
  const presetSelect = document.createElement("select");
  const presets = presetsForAirco(node.config.aircoId);
  for (const preset of presets) presetSelect.append(option(preset.id, preset.name));
  if (!presets.some((preset) => preset.id === node.config.presetId)) {
    presetSelect.append(option(node.config.presetId, "Missing preset"));
  }
  presetSelect.value = node.config.presetId;
  presetSelect.addEventListener("change", () => updateNode(node, { presetId: presetSelect.value }));
  fragment.append(labeledControl("Air conditioner", unitSelect), labeledControl("Preset", presetSelect));
  return fragment;
}

function powerActionBody(node) {
  const fragment = document.createDocumentFragment();
  fragment.append(
    labeledControl("Air conditioner", aircoSelect(node.config.aircoId, (value) => updateNode(node, { aircoId: value }, { rerender: true }))),
    labeledControl("Action", simpleSelect([
      ["off", "Off now"],
      ["on", "On"],
      ["clean", "Clean 30 min → Off"],
    ], node.config.state, (value) => updateNode(node, {
      state: value,
      ...(value === "clean" ? { durationMinutes: 30 } : {}),
    })))
  );
  return fragment;
}

function nodeBody(node) {
  if (node.type === "temperature") return temperatureBody(node);
  if (node.type === "power") return powerBody(node);
  if (node.type === "mode") return modeBody(node);
  if (node.type === "time") return timeBody(node);
  if (LOGIC_TYPES.has(node.type)) return logicBody(node);
  if (node.type === "apply-preset") return presetBody(node);
  return powerActionBody(node);
}

function renderNode(node) {
  const meta = NODE_META[node.type];
  const card = el("article", "automation-node");
  card.dataset.nodeId = node.id;
  card.dataset.kind = meta.kind;
  card.style.left = `${node.position.x}px`;
  card.style.top = `${node.position.y}px`;

  const head = el("header", "automation-node-head");
  const title = el("span", "automation-node-title");
  title.append(el("span", "automation-node-icon", meta.icon), document.createTextNode(meta.title));
  const remove = el("button", "automation-node-remove", "×");
  remove.type = "button";
  remove.title = "Remove block";
  remove.setAttribute("aria-label", `Remove ${meta.title} block`);
  remove.addEventListener("click", () => removeAutomationNode(node.id));
  head.append(title, remove);
  head.addEventListener("pointerdown", (event) => startNodeDrag(event, node, card));

  const body = el("div", "automation-node-body");
  body.append(nodeBody(node));
  const live = el("span", "automation-node-live");
  const state = currentNodeMessage(node);
  live.dataset.result = state.result;
  live.textContent = state.message;
  live.title = state.message;
  body.append(live);
  card.classList.toggle("has-error", state.result === "error");
  card.append(head, body);

  if (LOGIC_TYPES.has(node.type) || ACTION_TYPES.has(node.type)) {
    const input = el("button", "automation-port automation-port-input");
    input.type = "button";
    input.dataset.portNode = node.id;
    input.title = "Input";
    input.setAttribute("aria-label", `Input for ${meta.title}`);
    input.addEventListener("click", (event) => finishPendingConnection(event, node.id));
    card.append(input);
  }
  if (CONDITION_TYPES.has(node.type) || LOGIC_TYPES.has(node.type)) {
    const output = el("button", "automation-port automation-port-output");
    output.type = "button";
    output.dataset.portNode = node.id;
    output.title = "Drag to an input";
    output.setAttribute("aria-label", `Output from ${meta.title}`);
    output.classList.toggle("pending", automationState.pendingConnection === node.id);
    output.addEventListener("pointerdown", (event) => startConnectionDrag(event, node.id));
    card.append(output);
  }
  return card;
}

function growAutomationCanvas(requiredWidth, requiredHeight) {
  const width = Math.max(CANVAS_MIN_WIDTH, automationCanvas.offsetWidth, Math.ceil(requiredWidth));
  const height = Math.max(CANVAS_MIN_HEIGHT, automationCanvas.offsetHeight, Math.ceil(requiredHeight));
  automationCanvas.style.width = `${width}px`;
  automationCanvas.style.height = `${height}px`;
}

function fitAutomationCanvasToNodes() {
  let requiredWidth = CANVAS_MIN_WIDTH;
  let requiredHeight = CANVAS_MIN_HEIGHT;
  automationNodes.querySelectorAll(".automation-node").forEach((card) => {
    requiredWidth = Math.max(requiredWidth, card.offsetLeft + card.offsetWidth + CANVAS_RIGHT_SPACE);
    requiredHeight = Math.max(requiredHeight, card.offsetTop + card.offsetHeight + CANVAS_BOTTOM_SPACE);
  });
  growAutomationCanvas(requiredWidth, requiredHeight);
}

function renderAutomationCanvas() {
  const nodes = automationState.draft?.nodes || [];
  automationNodes.replaceChildren(...nodes.map(renderNode));
  automationCanvasHint.classList.toggle("is-hidden", nodes.length > 0);
  requestAnimationFrame(() => {
    fitAutomationCanvasToNodes();
    drawAutomationConnections();
  });
}

function portPoint(nodeId, direction) {
  const selector = `.automation-node[data-node-id="${CSS.escape(nodeId)}"] .automation-port-${direction}`;
  const port = automationNodes.querySelector(selector);
  if (!port) return null;
  const portRect = port.getBoundingClientRect();
  const canvasRect = automationCanvas.getBoundingClientRect();
  return {
    x: portRect.left - canvasRect.left + portRect.width / 2,
    y: portRect.top - canvasRect.top + portRect.height / 2,
  };
}

function bezierPath(start, end) {
  const bend = Math.max(70, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function edgeIsActive(edge) {
  const nodeState = automationState.draft?.runtime?.nodeStates?.[edge.from];
  return !automationState.dirty && nodeState?.result === true;
}

function drawAutomationConnections(previewPoint = null) {
  const children = [];
  for (const edge of automationState.draft?.edges || []) {
    const start = portPoint(edge.from, "output");
    const end = portPoint(edge.to, "input");
    if (!start || !end) continue;
    const d = bezierPath(start, end);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `automation-edge${edgeIsActive(edge) ? " active" : ""}`);
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "automation-edge-hit");
    hit.addEventListener("click", () => removeAutomationEdge(edge.id));
    children.push(path, hit);
  }
  if (automationState.connectionDrag && previewPoint) {
    const start = portPoint(automationState.connectionDrag.from, "output");
    if (start) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", bezierPath(start, previewPoint));
      path.setAttribute("class", "automation-edge-preview");
      children.push(path);
    }
  }
  automationConnections.replaceChildren(...children);
  automationConnections.setAttribute("viewBox", `0 0 ${automationCanvas.offsetWidth} ${automationCanvas.offsetHeight}`);
}

function defaultNode(type, position) {
  const aircoId = firstAircoId();
  const firstPreset = presetsForAirco(aircoId)[0];
  const configs = {
    temperature: { aircoId, sensor: "indoor", operator: "gt", value: 25 },
    power: { aircoId, state: "off", durationMinutes: 0 },
    mode: { aircoId, mode: "cool" },
    time: { start: "08:00", end: "22:00", days: [0, 1, 2, 3, 4, 5, 6] },
    and: {},
    or: {},
    "apply-preset": { aircoId, presetId: firstPreset?.id || "missing-preset" },
    "set-power": { aircoId, state: "off" },
  };
  return { id: automationId(type), type, position, config: configs[type] };
}

function addAutomationNode(type, x, y) {
  if (!automationState.draft) return;
  if ((type === "temperature" || type === "power" || type === "mode" || ACTION_TYPES.has(type)) && !firstAircoId()) {
    setAutomationHelp("Add an air conditioner before adding this block.");
    return;
  }
  const requestedX = Math.max(20, Math.round(x));
  const requestedY = Math.max(20, Math.round(y));
  growAutomationCanvas(requestedX + 280 + CANVAS_RIGHT_SPACE, requestedY + 260 + CANVAS_BOTTOM_SPACE);
  const position = { x: requestedX, y: requestedY };
  automationState.draft.nodes.push(defaultNode(type, position));
  markAutomationDirty("Block added. Connect its port to the flow.");
  renderAutomationCanvas();
}

function removeAutomationNode(id) {
  if (!automationState.draft) return;
  automationState.draft.nodes = automationState.draft.nodes.filter((node) => node.id !== id);
  automationState.draft.edges = automationState.draft.edges.filter((edge) => edge.from !== id && edge.to !== id);
  if (automationState.pendingConnection === id) automationState.pendingConnection = null;
  markAutomationDirty("Block removed.");
  renderAutomationCanvas();
}

function removeAutomationEdge(id) {
  automationState.draft.edges = automationState.draft.edges.filter((edge) => edge.id !== id);
  markAutomationDirty("Connection removed.");
  drawAutomationConnections();
}

function connectionCreatesCycle(from, to) {
  const adjacency = new Map(automationState.draft.nodes.map((node) => [node.id, []]));
  for (const edge of automationState.draft.edges) adjacency.get(edge.from)?.push(edge.to);
  adjacency.get(from)?.push(to);
  const stack = [to];
  const seen = new Set();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adjacency.get(id) || []));
  }
  return false;
}

function connectAutomationNodes(from, to) {
  const source = automationState.draft.nodes.find((node) => node.id === from);
  const target = automationState.draft.nodes.find((node) => node.id === to);
  if (!source || !target || from === to || ACTION_TYPES.has(source.type) || CONDITION_TYPES.has(target.type)) return;
  if (automationState.draft.edges.some((edge) => edge.from === from && edge.to === to)) return;
  if (connectionCreatesCycle(from, to)) {
    setAutomationHelp("That connection would create a loop.");
    return;
  }
  if (ACTION_TYPES.has(target.type)) {
    automationState.draft.edges = automationState.draft.edges.filter((edge) => edge.to !== to);
  }
  automationState.draft.edges.push({ id: automationId("edge"), from, to });
  automationState.pendingConnection = null;
  markAutomationDirty("Blocks connected.");
  renderAutomationCanvas();
}

function finishPendingConnection(event, to) {
  event.preventDefault();
  event.stopPropagation();
  if (!automationState.pendingConnection) return;
  connectAutomationNodes(automationState.pendingConnection, to);
}

function canvasPointFromClient(clientX, clientY) {
  const rect = automationCanvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function startConnectionDrag(event, from) {
  event.preventDefault();
  event.stopPropagation();
  automationState.connectionDrag = {
    from,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  drawAutomationConnections(canvasPointFromClient(event.clientX, event.clientY));
}

function startNodeDrag(event, node, card) {
  if (event.button !== 0 || event.target.closest("button, input, select, label")) return;
  event.preventDefault();
  automationState.nodeDrag = {
    id: node.id,
    startX: event.clientX,
    startY: event.clientY,
    originX: node.position.x,
    originY: node.position.y,
    scrollLeft: automationViewport.scrollLeft,
    scrollTop: automationViewport.scrollTop,
    card,
    moved: false,
  };
  card.classList.add("is-dragging");
}

function handleAutomationPointerMove(event) {
  const pan = automationState.canvasPan;
  if (pan) {
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (Math.hypot(dx, dy) > 3) pan.moved = true;
    automationViewport.scrollLeft = pan.scrollLeft - dx;
    automationViewport.scrollTop = pan.scrollTop - dy;
  }

  const connection = automationState.connectionDrag;
  if (connection) {
    if (Math.hypot(event.clientX - connection.startX, event.clientY - connection.startY) > 4) connection.moved = true;
    drawAutomationConnections(canvasPointFromClient(event.clientX, event.clientY));
  }

  const drag = automationState.nodeDrag;
  if (!drag) return;
  const node = automationState.draft.nodes.find((candidate) => candidate.id === drag.id);
  if (!node) return;
  const viewportRect = automationViewport.getBoundingClientRect();
  if (event.clientX > viewportRect.right - 42) automationViewport.scrollLeft += 18;
  else if (event.clientX < viewportRect.left + 42) automationViewport.scrollLeft -= 18;
  if (event.clientY > viewportRect.bottom - 42) automationViewport.scrollTop += 18;
  else if (event.clientY < viewportRect.top + 42) automationViewport.scrollTop -= 18;

  const dx = event.clientX - drag.startX + (automationViewport.scrollLeft - drag.scrollLeft);
  const dy = event.clientY - drag.startY + (automationViewport.scrollTop - drag.scrollTop);
  if (Math.hypot(dx, dy) > 3) drag.moved = true;
  const requestedX = Math.max(10, Math.round(drag.originX + dx));
  const requestedY = Math.max(10, Math.round(drag.originY + dy));
  growAutomationCanvas(
    requestedX + drag.card.offsetWidth + CANVAS_RIGHT_SPACE,
    requestedY + drag.card.offsetHeight + CANVAS_BOTTOM_SPACE
  );
  node.position.x = requestedX;
  node.position.y = requestedY;
  drag.card.style.left = `${node.position.x}px`;
  drag.card.style.top = `${node.position.y}px`;
  drawAutomationConnections();
}

function handleAutomationPointerUp(event) {
  if (automationState.canvasPan) {
    automationState.canvasPan = null;
    automationCanvas.classList.remove("is-panning");
  }

  const connection = automationState.connectionDrag;
  if (connection) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".automation-port-input");
    automationState.connectionDrag = null;
    if (target) connectAutomationNodes(connection.from, target.dataset.portNode);
    else if (!connection.moved) {
      automationState.pendingConnection = connection.from;
      setAutomationHelp("Now tap an input dot to finish the connection.");
      renderAutomationCanvas();
    } else {
      drawAutomationConnections();
    }
  }

  const drag = automationState.nodeDrag;
  if (drag) {
    drag.card.classList.remove("is-dragging");
    automationState.nodeDrag = null;
    if (drag.moved) markAutomationDirty("Block moved.");
  }
}

async function saveAutomation() {
  if (!automationState.draft || automationState.busy) return;
  const name = automationName.value.trim();
  if (!name) {
    setAutomationHelp("Give this flow a name before saving.");
    automationName.focus();
    return;
  }
  automationState.busy = true;
  saveAutomationButton.disabled = true;
  saveAutomationButton.textContent = "Saving...";
  try {
    const saved = await request(`/api/automations/${encodeURIComponent(automationState.draft.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name,
        enabled: automationEnabled.checked,
        nodes: automationState.draft.nodes,
        edges: automationState.draft.edges,
      }),
    });
    const index = automationState.automations.findIndex((automation) => automation.id === saved.id);
    if (index >= 0) automationState.automations[index] = saved;
    automationState.draft = cloneValue(saved);
    clearAutomationDirty();
    renderAutomationList();
    renderAutomationEditor();
  } catch (err) {
    setAutomationHelp(automationError(err));
    saveAutomationButton.textContent = "Save changes";
  } finally {
    automationState.busy = false;
    saveAutomationButton.disabled = false;
  }
}

async function createBlankAutomation() {
  if (automationState.busy) return;
  if (automationState.dirty && !window.confirm("Discard the unsaved changes to this flow?")) return;
  automationState.busy = true;
  try {
    const created = await request("/api/automations", {
      method: "POST",
      body: JSON.stringify({ name: "New automation", enabled: false, nodes: [], edges: [] }),
    });
    await loadAutomationData({ selectId: created.id, force: true });
    automationName.select();
  } catch (err) {
    window.alert(automationError(err));
  } finally {
    automationState.busy = false;
  }
}

async function deleteSelectedAutomation() {
  const draft = automationState.draft;
  if (!draft || automationState.busy) return;
  if (!window.confirm(`Delete automation "${draft.name}"?`)) return;
  automationState.busy = true;
  try {
    await request(`/api/automations/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
    automationState.selectedId = null;
    automationState.draft = null;
    automationState.dirty = false;
    await loadAutomationData({ force: true });
  } catch (err) {
    setAutomationHelp(automationError(err));
  } finally {
    automationState.busy = false;
  }
}

function shortcutEl(name) {
  return shortcutDialog.querySelector(`[data-shortcut="${name}"]`);
}

function populateShortcutPresets() {
  const aircoId = shortcutForm.elements.shortcutAirco.value;
  const select = shortcutForm.elements.shortcutPreset;
  const presets = presetsForAirco(aircoId);
  select.replaceChildren(...presets.map((preset) => option(preset.id, preset.name)));
  select.disabled = presets.length === 0;
  shortcutEl("error").textContent = presets.length === 0 ? "Save a preset for this air conditioner first." : "";
}

function updateShortcutStrategy({ setDefaults = false } = {}) {
  const strategy = shortcutForm.elements.shortcutStopStrategy.value;
  const branch = shortcutEl("stopBranch");
  const hysteresisRow = shortcutEl("hysteresisRow");
  branch.classList.toggle("is-hidden", strategy === "none");
  if (strategy === "none") return;
  const preset = presetsForAirco(shortcutForm.elements.shortcutAirco.value)
    .find((candidate) => candidate.id === shortcutForm.elements.shortcutPreset.value);
  if (strategy === "indoor") {
    hysteresisRow.classList.add("is-hidden");
    shortcutEl("stopCopy").textContent = "When indoor temperature is below";
    if (setDefaults && preset) {
      shortcutForm.elements.shortcutStart.value = Math.min(35, Number(preset.settings.temperature) + 1);
      shortcutForm.elements.shortcutStop.value = Math.min(34.5, Number(preset.settings.temperature) + 0.5);
    }
    shortcutEl("guardCopy").textContent = "The stop value may be slightly above the preset temperature, but must stay below the switch-on value.";
  } else {
    hysteresisRow.classList.remove("is-hidden");
    shortcutEl("stopCopy").textContent = "When outdoor temperature is below";
    if (setDefaults) {
      shortcutForm.elements.shortcutStop.value = 23.5;
      shortcutForm.elements.shortcutHysteresis.value = 1.5;
    }
    const stop = Number(shortcutForm.elements.shortcutStop.value);
    const hysteresis = Number(shortcutForm.elements.shortcutHysteresis.value);
    const restart = Number.isFinite(stop) && Number.isFinite(hysteresis) ? stop + hysteresis : null;
    shortcutEl("guardCopy").textContent = `The on branch waits until it is at least ${restart ?? "—"} °C outdoors, creating a ${Number.isFinite(hysteresis) ? hysteresis : "—"} °C safety gap.`;
  }
}

function openShortcutDialog() {
  if (automationState.dirty && !window.confirm("Discard the unsaved changes to this flow?")) return;
  shortcutForm.reset();
  shortcutForm.elements.shortcutAirco.replaceChildren(...automationState.aircos.map((item) => option(item.airco.id, item.airco.name)));
  shortcutEl("error").textContent = "";
  populateShortcutPresets();
  updateShortcutStrategy();
  if (automationState.aircos.length === 0) shortcutEl("error").textContent = "Add an air conditioner first.";
  shortcutDialog.showModal();
}

async function createTemperatureShortcut(event) {
  event.preventDefault();
  if (automationState.busy) return;
  const strategy = shortcutForm.elements.shortcutStopStrategy.value;
  const start = Number(shortcutForm.elements.shortcutStart.value);
  const stop = Number(shortcutForm.elements.shortcutStop.value);
  const outdoorHysteresis = Number(shortcutForm.elements.shortcutHysteresis.value);
  if (!shortcutForm.elements.shortcutPreset.value) {
    shortcutEl("error").textContent = "Select a preset to start.";
    return;
  }
  if (strategy === "indoor" && stop >= start) {
    shortcutEl("error").textContent = "For indoor control, the switch-off temperature must be lower than the switch-on temperature.";
    return;
  }
  if (strategy === "outdoor" && (!Number.isFinite(outdoorHysteresis) || outdoorHysteresis < 0.5 || outdoorHysteresis > 10)) {
    shortcutEl("error").textContent = "Outdoor hysteresis must be between 0.5 and 10 °C.";
    return;
  }
  automationState.busy = true;
  shortcutEl("create").disabled = true;
  shortcutEl("create").textContent = "Creating...";
  try {
    const created = await request("/api/automations/temperature-shortcut", {
      method: "POST",
      body: JSON.stringify({
        name: shortcutForm.elements.shortcutName.value.trim(),
        aircoId: shortcutForm.elements.shortcutAirco.value,
        presetId: shortcutForm.elements.shortcutPreset.value,
        startTemperature: start,
        stopStrategy: strategy,
        stopTemperature: strategy === "none" ? undefined : stop,
        outdoorHysteresis: strategy === "outdoor" ? outdoorHysteresis : undefined,
      }),
    });
    shortcutDialog.close();
    await loadAutomationData({ selectId: created.id, force: true });
  } catch (err) {
    shortcutEl("error").textContent = automationError(err);
  } finally {
    automationState.busy = false;
    shortcutEl("create").disabled = false;
    shortcutEl("create").textContent = "Create flow";
  }
}

document.getElementById("showAircos").addEventListener("click", () => switchMainView("aircos"));
document.getElementById("showAutomations").addEventListener("click", () => switchMainView("automations"));
document.getElementById("newAutomation").addEventListener("click", createBlankAutomation);
document.getElementById("temperatureShortcut").addEventListener("click", () => {
  setAutomationPaletteOpen(false);
  openShortcutDialog();
});
automationEmpty.querySelector('[data-automation-empty="shortcut"]').addEventListener("click", openShortcutDialog);
saveAutomationButton.addEventListener("click", saveAutomation);
deleteAutomationButton.addEventListener("click", deleteSelectedAutomation);
refreshAutomationActivity.addEventListener("click", () => {
  automationActivitySummary.textContent = "Refreshing activity...";
  loadAutomationActivity().catch((err) => {
    automationActivitySummary.textContent = automationError(err);
  });
});
clearAutomationActivity.addEventListener("click", clearAutomationActivityLog);
automationPaletteToggle.addEventListener("click", () => {
  const open = automationPalette.classList.contains("is-hidden");
  if (open) automationFlowPicker.open = false;
  setAutomationPaletteOpen(open);
});
automationFlowPicker.addEventListener("toggle", () => {
  if (automationFlowPicker.open) setAutomationPaletteOpen(false);
});
document.addEventListener("pointerdown", (event) => {
  if (automationFlowPicker.open && !automationFlowPicker.contains(event.target)) automationFlowPicker.open = false;
  if (!automationPalette.classList.contains("is-hidden") && !automationPaletteDock.contains(event.target)) {
    setAutomationPaletteOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (automationFlowPicker.open) {
    automationFlowPicker.open = false;
    automationFlowPicker.querySelector("summary").focus();
  } else if (!automationPalette.classList.contains("is-hidden")) {
    setAutomationPaletteOpen(false);
    automationPaletteToggle.focus();
  }
});
automationActivity.addEventListener("toggle", () => {
  if (!automationActivity.open) return;
  automationActivitySummary.textContent = "Loading activity...";
  loadAutomationActivity().catch((err) => {
    automationActivitySummary.textContent = automationError(err);
  });
});

automationName.addEventListener("input", () => {
  if (!automationState.draft) return;
  automationState.draft.name = automationName.value;
  markAutomationDirty();
});
automationEnabled.addEventListener("change", () => {
  if (!automationState.draft) return;
  automationState.draft.enabled = automationEnabled.checked;
  markAutomationDirty();
});
document.querySelectorAll(".palette-block[data-node-type]").forEach((button) => {
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-airco-node", button.dataset.nodeType);
  });
  button.addEventListener("dragend", () => setAutomationPaletteOpen(false));
  button.addEventListener("click", () => {
    const x = automationViewport.scrollLeft + 80 + (automationState.paletteOffset % 3) * 34;
    const y = automationViewport.scrollTop + 70 + (automationState.paletteOffset % 5) * 55;
    automationState.paletteOffset += 1;
    addAutomationNode(button.dataset.nodeType, x, y);
    setAutomationPaletteOpen(false);
  });
});

automationCanvas.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  automationCanvas.classList.add("drag-over");
});
automationCanvas.addEventListener("dragleave", (event) => {
  if (!automationCanvas.contains(event.relatedTarget)) automationCanvas.classList.remove("drag-over");
});
automationCanvas.addEventListener("drop", (event) => {
  event.preventDefault();
  automationCanvas.classList.remove("drag-over");
  const type = event.dataTransfer.getData("application/x-airco-node");
  if (!NODE_META[type]) return;
  const point = canvasPointFromClient(event.clientX, event.clientY);
  addAutomationNode(type, point.x - 100, point.y - 35);
  setAutomationPaletteOpen(false);
});
automationCanvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".automation-node, .automation-edge-hit")) return;
  automationState.canvasPan = {
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: automationViewport.scrollLeft,
    scrollTop: automationViewport.scrollTop,
    moved: false,
  };
  automationCanvas.setPointerCapture?.(event.pointerId);
  automationCanvas.classList.add("is-panning");
  event.preventDefault();
});

window.addEventListener("pointermove", handleAutomationPointerMove);
window.addEventListener("pointerup", handleAutomationPointerUp);
window.addEventListener("resize", () => {
  if (automationState.view === "automations") drawAutomationConnections();
});
window.addEventListener("beforeunload", (event) => {
  if (!automationState.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

shortcutForm.elements.shortcutAirco.addEventListener("change", () => {
  populateShortcutPresets();
  updateShortcutStrategy({ setDefaults: shortcutForm.elements.shortcutStopStrategy.value === "indoor" });
});
shortcutForm.elements.shortcutPreset.addEventListener("change", () => {
  updateShortcutStrategy({ setDefaults: shortcutForm.elements.shortcutStopStrategy.value === "indoor" });
});
shortcutForm.querySelectorAll('[name="shortcutStopStrategy"]').forEach((radio) => {
  radio.addEventListener("change", () => updateShortcutStrategy({ setDefaults: true }));
});
shortcutForm.elements.shortcutStop.addEventListener("input", () => updateShortcutStrategy());
shortcutForm.elements.shortcutHysteresis.addEventListener("input", () => updateShortcutStrategy());
shortcutForm.addEventListener("submit", createTemperatureShortcut);
shortcutEl("cancel").addEventListener("click", () => shortcutDialog.close());
shortcutEl("close").addEventListener("click", () => shortcutDialog.close());

setInterval(() => {
  if (automationState.view === "automations" && !automationState.dirty && !automationState.busy) {
    loadAutomationData().catch(() => {});
  }
}, 10000);

switchMainView(location.hash === "#automations" ? "automations" : "aircos", { updateHash: false });
