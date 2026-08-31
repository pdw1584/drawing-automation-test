const frames = new Map();
const pendingFiles = new Map();
const sentFiles = new Map();
const CAD_RUNTIME_VERSION = "20260831-2";
let viewSyncEnabled = true;

function ensureFrame(side) {
  const host = document.querySelector(`#${side}Viewer`);
  if (!host) return null;
  let frame = frames.get(side);
  if (frame?.isConnected) return frame;

  host.replaceChildren();
  frame = document.createElement("iframe");
  frame.className = "cad-render-frame";
  frame.title = side === "old" ? "원본 CAD 도면" : "변경 CAD 도면";
  frame.src = `/cad-frame.html?runtime=${CAD_RUNTIME_VERSION}&side=${encodeURIComponent(side)}`;
  host.append(frame);
  frames.set(side, frame);
  return frame;
}

async function postFile(side, file) {
  if (sentFiles.get(side) === file) return;
  const frame = ensureFrame(side);
  if (!frame?.contentWindow) return;
  const buffer = await file.arrayBuffer();
  frame.contentWindow.postMessage({
    type: "cad-renderer-load",
    side,
    name: file.name,
    buffer
  }, window.location.origin, [buffer]);
  sentFiles.set(side, file);
}

export function renderCadFile(side, file) {
  pendingFiles.set(side, file);
  const frame = ensureFrame(side);
  if (frame?.dataset.ready === "true") void postFile(side, file);
}

export function fitCadViews() {
  for (const [side, frame] of frames) {
    frame.contentWindow?.postMessage({ type: "cad-renderer-fit", side }, window.location.origin);
  }
}

export function focusCadViews(center) {
  for (const [side, frame] of frames) {
    frame.contentWindow?.postMessage({
      type: "cad-renderer-focus",
      side,
      center
    }, window.location.origin);
  }
}

export function setCadViewSync(enabled) {
  viewSyncEnabled = Boolean(enabled);
}

window.addEventListener("message", event => {
  if (event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "cad-renderer-ready") {
    const entry = [...frames.entries()].find(([, frame]) => frame.contentWindow === event.source);
    if (!entry) return;
    const [side, frame] = entry;
    frame.dataset.ready = "true";
    const file = pendingFiles.get(side);
    if (file) void postFile(side, file);
  }
  if (message.type === "cad-renderer-error") {
    document.querySelector("#status").textContent = `${message.side === "old" ? "원본" : "변경본"} 고성능 렌더링 실패: ${message.detail}`;
  }
  if (message.type === "cad-renderer-view-changed" && viewSyncEnabled) {
    for (const [side, frame] of frames) {
      if (frame.contentWindow === event.source || side === message.side) continue;
      frame.contentWindow?.postMessage({
        type: "cad-renderer-apply-view",
        center: message.center,
        zoom: message.zoom
      }, window.location.origin);
    }
  }
});
