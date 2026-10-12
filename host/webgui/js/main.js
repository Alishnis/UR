import { Config } from "./config.js";
import { WsTransport } from "./transport/ws_transport.js";
import { Protocol } from "./protocol/protocol.js";
import { Camera } from "./camera/camera.js";
import { DetectorFilters, ViewFilters, buildFilterString, canvasFiltersSupported } from "./camera/filter_state.js";
import { InputState } from "./input/input_state.js";
import { initKeyboard, pollKeyboard } from "./input/keyboard.js";
import { CommandLoop } from "./control/command_loop.js";
import { fromSlots } from "./control/mixer.js";
import { TagClient } from "./vision/tag_client.js";
import { drawArmState, drawMissionBanner, drawTags } from "./vision/overlay.js";
import { StatusPanel } from "./ui/status.js";
import { FilterPanel } from "./ui/filter_panel.js";
import { ThrusterDisplay } from "./ui/thruster_display.js";
import { TagsPanel } from "./ui/tags_panel.js";
import { NetworkPanel } from "./ui/network_panel.js";
import { initThrusterTest } from "./ui/thruster_test.js";

const $ = (id) => document.getElementById(id);
const videoEl = $("camera");
const displayCanvas = $("displayCanvas");  // pilot view (view filters)
const displayCtx = displayCanvas.getContext("2d");
const frameCanvas = document.createElement("canvas");  // the frame sent to the AprilTag service (detector filters)
const frameCtx = frameCanvas.getContext("2d");
const detectorCanvas = $("detectorCanvas");  // shows frameCanvas + detections
const detectorCtx = detectorCanvas.getContext("2d");

// --- control ---
InputState.magnitude = Config.magnitudeStart;
const status = new StatusPanel();
const transport = new WsTransport(Config.wsUrl);
const commandLoop = new CommandLoop(transport, Config);
const networkPanel = new NetworkPanel($("network-panel"), transport);
const thrusterDisplay = new ThrusterDisplay($("vector-display"), Config);
let telemetryUs = null;
let lastEspLine = 0;

const maxSlider = $("max-throttle");
maxSlider.max = Config.maxThrottleLimit;
maxSlider.value = Config.maxThrottle;
const showMax = () => { $("max-value").textContent = Number(maxSlider.value).toFixed(2); };
maxSlider.addEventListener("input", () => { commandLoop.setMaxThrottle(Number(maxSlider.value)); showMax(); });
showMax();

function refreshArmButton() {
  const btn = $("btn-arm");
  btn.disabled = !transport.isConnected();
  btn.textContent = commandLoop.armed ? "DISARM" : "ARM";
  btn.classList.toggle("armed", commandLoop.armed);
}

function estop(reason = "E-STOP") {
  commandLoop.disarm();
  refreshArmButton();
  $("arm-message").textContent = `${reason}: thrusters stopped - press ARM to drive again`;
}

transport.onStatus((s) => {
  status.setTransport(s);
  networkPanel.setConnected(s === "connected");
  if (s !== "connected") {
    commandLoop.armed = false;
    $("btn-connect").disabled = false;
    $("btn-disconnect").disabled = true;
  }
  refreshArmButton();
});

transport.onLine((line) => {
  lastEspLine = performance.now();
  const msg = Protocol.parseLine(line);
  if (msg.type === "telemetry") telemetryUs = fromSlots(msg.us, Config.outputSlot);  // -> [left, right, vert]
  else if (msg.type === "network") networkPanel.push(msg.text);
  else if (msg.type === "warning") {
    $("esp-warning").textContent = msg.text;
    networkPanel.push("WARNING " + msg.text);
  }
});

$("btn-connect").addEventListener("click", async () => {
  try {
    await transport.connect();
    commandLoop.start();
    $("btn-connect").disabled = true;
    $("btn-disconnect").disabled = false;
  } catch (e) {
    status.setTransport("error");
    $("arm-message").textContent = e.message;
  }
});

$("btn-disconnect").addEventListener("click", () => {
  commandLoop.disarm();
  commandLoop.stop();
  transport.disconnect();
});

$("btn-arm").addEventListener("click", () => {
  if (commandLoop.armed) {
    estop("DISARMED");
    return;
  }
  const problem = commandLoop.arm();
  $("arm-message").textContent = problem ? `cannot arm: ${problem}` : "";
  refreshArmButton();
  $("btn-arm").blur();  // so Space / keys go to driving, not to the button
});

$("btn-estop").addEventListener("click", () => estop());
initKeyboard({ onEstop: () => estop() });
initThrusterTest($("thruster-test"), {
  isArmed: () => commandLoop.armed,
  onNotArmed: () => { $("arm-message").textContent = "THRUSTER TEST: press ARM first"; },
});

// --- camera ---
const camera = new Camera(videoEl);
const cameraSelect = $("camera-select");

async function fillCameraList() {
  const keep = cameraSelect.value;
  const devices = await camera.listDevices();
  cameraSelect.innerHTML = "";
  devices.forEach((d, i) => cameraSelect.add(new Option(d.label || `camera ${i + 1}`, d.deviceId)));
  if (!devices.length) cameraSelect.add(new Option("default camera", ""));
  cameraSelect.add(new Option("test image: 3 tags (tags/sheet.png)", "image:/tags/sheet.png"));
  if ([...cameraSelect.options].some((o) => o.value === keep)) cameraSelect.value = keep;
}
fillCameraList();

$("btn-camera").addEventListener("click", async () => {
  try {
    if (!camera.isRunning()) {
      status.setCamera("starting");
      await camera.start(cameraSelect.value);
      status.setCamera("running");
      $("btn-camera").textContent = "Stop Camera";
      fillCameraList();  // names become visible after the permission prompt
    } else {
      camera.stop();
      status.setCamera("off");
      $("btn-camera").textContent = "Start Camera";
      displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    }
  } catch (e) {
    console.error("camera failed", e);
    status.setCamera("error");
    $("arm-message").textContent = `camera: ${e.message}`;
  }
});
new FilterPanel($("filters"), ViewFilters);
new FilterPanel($("detector-filters"), DetectorFilters, {
  copySource: ViewFilters,
  copyLabel: "Same as pilot view",
  onChange: () => {
    $("detector-label").textContent = !canvasFiltersSupported
      ? "this browser ignores canvas filters - use Chrome / Safari 18+"
      : DetectorFilters.isDefault() ? "exactly what the AprilTag detector gets (no filters)"
      : `exactly what the AprilTag detector gets: ${buildFilterString(DetectorFilters)}`;
  },
});

const layoutSelect = $("view-layout");
try { layoutSelect.value = localStorage.getItem("ur-rov-layout") || "both"; } catch (_) { /* defaults */ }
const applyLayout = () => {
  $("camera-area").dataset.layout = layoutSelect.value;
  try { localStorage.setItem("ur-rov-layout", layoutSelect.value); } catch (_) { /* not remembered */ }
};
layoutSelect.addEventListener("change", applyLayout);
applyLayout();

// --- AprilTag (Mission 2.1) ---
const tags = new TagClient(Config.visionUrl);
const tagsPanel = new TagsPanel($("tags-panel"), tags);
let lastTags = null;  // last detection result (boxes)
let tagState = null;  // rule / confirmed / selected
let lastSent = 0;

tags.on("status", (s) => status.setVision(s === "connected" ? "ok" : s));
tags.on("result", (r) => {
  if (r.type === "error") { console.warn(r.text); return; }
  if (r.type === "tags") {
    lastTags = r;
    status.setVision(`ok ${r.ms} ms`);
  }
  tagState = r;
  tagsPanel.update(r);
});
tags.connect();

function maybeSendFrame(now) {
  if (!camera.isRunning() || !camera.width || !tags.canSendFrame()) return;
  if (now - lastSent < 1000 / Config.detectionHz) return;
  lastSent = now;
  const scale = Math.min(1, Config.detectionWidth / camera.width);
  const w = Math.round(camera.width * scale), h = Math.round(camera.height * scale);
  if (frameCanvas.width !== w || frameCanvas.height !== h) { frameCanvas.width = w; frameCanvas.height = h; }
  frameCtx.save();
  frameCtx.filter = buildFilterString(DetectorFilters, w);  // the view filters are for the eyes only
  frameCtx.drawImage(camera.element, 0, 0, w, h);
  frameCtx.restore();
  tags.sendFrame(frameCanvas, Config.jpegQuality);  // the JPEG is taken from the canvas right now
}

function render() {
  if (!camera.isRunning() || !camera.width) return;
  if (displayCanvas.width !== camera.width || displayCanvas.height !== camera.height) {
    displayCanvas.width = camera.width;
    displayCanvas.height = camera.height;
  }
  const layout = layoutSelect.value;
  if (layout !== "detector") {
    displayCtx.save();
    displayCtx.filter = buildFilterString(ViewFilters, displayCanvas.width);
    displayCtx.drawImage(camera.element, 0, 0, displayCanvas.width, displayCanvas.height);
    displayCtx.restore();
    if (lastTags) {
      drawTags(displayCtx, lastTags, displayCanvas.width / lastTags.width, displayCanvas.height / lastTags.height);
    }
    drawMissionBanner(displayCtx, tagState);
    drawArmState(displayCtx, commandLoop.armed, displayCanvas.width);
  }
  if (layout !== "pilot" && frameCanvas.width) {
    // the last frame that was sent, unchanged (frameCanvas is only redrawn right before the next send)
    if (detectorCanvas.width !== frameCanvas.width || detectorCanvas.height !== frameCanvas.height) {
      detectorCanvas.width = frameCanvas.width;
      detectorCanvas.height = frameCanvas.height;
    }
    detectorCtx.drawImage(frameCanvas, 0, 0);
    if (lastTags) {
      drawTags(detectorCtx, lastTags, detectorCanvas.width / lastTags.width, detectorCanvas.height / lastTags.height);
    }
    if (layout === "detector") {
      drawMissionBanner(detectorCtx, tagState);
      drawArmState(detectorCtx, commandLoop.armed, detectorCanvas.width);
    }
  }
}

// --- main loop ---
let fpsFrames = 0;
let fpsLast = performance.now();

function frame(now) {
  pollKeyboard(now);
  const espAlive = now - lastEspLine < 1500;
  status.setEsp(transport.isConnected() && espAlive);
  thrusterDisplay.update(InputState, commandLoop.output, commandLoop.maxThrottle, commandLoop.armed,
                         espAlive ? telemetryUs : null);
  render();
  maybeSendFrame(now);
  fpsFrames++;
  if (now - fpsLast >= 1000) {
    status.setFps(Math.round((fpsFrames * 1000) / (now - fpsLast)));
    fpsFrames = 0;
    fpsLast = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("beforeunload", () => {
  commandLoop.disarm();
  transport.disconnect();
  camera.stop();
});
