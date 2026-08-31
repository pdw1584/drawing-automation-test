const frames = new Map();
const pendingFiles = new Map();
const sentFiles = new Map();
const hostSelectors = new Map();
const generations = new Map();
const CAD_RUNTIME_VERSION = "20260831-2";
let viewSyncEnabled = true;
let viewAlignment = null;

// 자동 정렬된 변경본 좌표와 원본 CAD 월드 좌표 사이를 왕복한다.
// 렌더러 자체 좌표를 바꾸지 않고 메시지 경계에서만 변환해 모델 데이터는 보존한다.
function transformPoint(point, inverse = false) {
  if (!viewAlignment?.applied || !point) return point;
  if (viewAlignment.mode !== "similarity") {
    return inverse
      ? { x: point.x - viewAlignment.dx, y: point.y - viewAlignment.dy }
      : { x: point.x + viewAlignment.dx, y: point.y + viewAlignment.dy };
  }
  const scale = viewAlignment.scale || 1;
  const angle = viewAlignment.angle || 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  if (inverse) {
    const x = (point.x - viewAlignment.dx) / scale;
    const y = (point.y - viewAlignment.dy) / scale;
    return { x: cos * x + sin * y, y: -sin * x + cos * y }
  }
  return {
    x: scale * (cos * point.x - sin * point.y) + viewAlignment.dx,
    y: scale * (sin * point.x + cos * point.y) + viewAlignment.dy
  }
}

function transformZoom(zoom, inverse = false) {
  if (viewAlignment?.mode !== "similarity" || !viewAlignment.applied) return zoom;
  return inverse ? zoom * viewAlignment.scale : zoom / viewAlignment.scale
}

function ensureFrame(side) {
  // 각 도면은 독립 iframe에서 렌더링해 WebGL 상태와 대형 모델 메모리를 분리한다.
  // iframe이 준비되기 전 선택된 파일은 pendingFiles에 보관했다가 ready 이후 전송한다.
  const host = document.querySelector(hostSelectors.get(side) || `#${side}Viewer`);
  if (!host) return null;
  let frame = frames.get(side);
  if (frame?.isConnected) return frame;

  host.replaceChildren();
  frame = document.createElement("iframe");
  frame.className = "cad-render-frame";
  frame.allow = "unload";
  frame.title = side === "old" ? "원본 CAD 도면" : "변경 CAD 도면";
  frame.src = `/cad-frame.html?runtime=${CAD_RUNTIME_VERSION}&side=${encodeURIComponent(side)}`;
  host.append(frame);
  frames.set(side, frame);
  return frame;
}

async function postFile(side, file, generation) {
  if (sentFiles.get(side) === file) return;
  const frame = ensureFrame(side);
  if (!frame?.contentWindow) return;
  // ArrayBuffer를 transfer list로 넘겨 대용량 파일 복사를 피한다. generation 검사는
  // 이전 비동기 파일 읽기가 새 선택 결과를 뒤늦게 덮어쓰는 경쟁 상태를 막는다.
  const buffer = await file.arrayBuffer();
  if (pendingFiles.get(side)?.generation !== generation) return;
  frame.contentWindow.postMessage({
    type: "cad-renderer-load",
    side,
    name: file.name,
    buffer
  }, window.location.origin, [buffer]);
  sentFiles.set(side, file);
}

export function renderCadFile(side, file, hostSelector) {
  if (hostSelector) hostSelectors.set(side, hostSelector);
  const generation = (generations.get(side) || 0) + 1;
  generations.set(side, generation);
  pendingFiles.set(side, {file, generation});
  const frame = ensureFrame(side);
  if (frame?.dataset.ready === "true") void postFile(side, file, generation);
}

export function fitCadViews() {
  for (const [side, frame] of frames) {
    frame.contentWindow?.postMessage({ type: "cad-renderer-fit", side }, window.location.origin);
  }
}

export function focusCadViews(centers) {
  for (const [side, frame] of frames) {
    const center = centers?.old || centers?.new ? centers[side] : centers;
    if (!center) continue;
    frame.contentWindow?.postMessage({
      type: "cad-renderer-focus",
      side,
      center
    }, window.location.origin);
  }
}

export function setCadViewSync(enabled) {
  // 카메라 중심과 확대율만 공유하고 도면 모델 및 렌더링 상태는 iframe별로 유지한다.
  viewSyncEnabled = Boolean(enabled);
}

export function setCadViewAlignment(alignment) {
  viewAlignment = alignment?.applied ? { ...alignment } : null;
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
    const pending = pendingFiles.get(side);
    if (pending) void postFile(side, pending.file, pending.generation);
  }
  if (message.type === "cad-renderer-error") {
    sentFiles.delete(message.side);
    const status = document.querySelector("#status, #reviewStatus, #renderStatus");
    if (status) status.textContent = `${message.side === "old" ? "원본" : message.side === "new" ? "변경본" : "도면"} 고성능 렌더링 실패: ${message.detail}`;
  }
  if (message.type === "cad-renderer-view-changed" && viewSyncEnabled) {
    for (const [side, frame] of frames) {
      if (frame.contentWindow === event.source || side === message.side) continue;
      const oldToNew = message.side === "old" && side === "new";
      const newToOld = message.side === "new" && side === "old";
      frame.contentWindow?.postMessage({
        type: "cad-renderer-apply-view",
        center: oldToNew ? transformPoint(message.center, true) : newToOld ? transformPoint(message.center) : message.center,
        zoom: oldToNew ? transformZoom(message.zoom, true) : newToOld ? transformZoom(message.zoom) : message.zoom
      }, window.location.origin);
    }
  }
});
