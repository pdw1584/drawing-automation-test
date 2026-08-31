import { AcApDocManager } from "@mlightcad/cad-simple-viewer";
import { AcDbDatabaseConverterManager, AcDbFileType } from "@mlightcad/data-model";
import { AcDbLibreDwgConverter } from "@mlightcad/libredwg-converter";

const statusElement = document.querySelector("#cad-status");
const container = document.querySelector("#cad-container");
const focusMarker = document.querySelector("#cad-focus-marker");
const assetRoot = new URL("/cad-assets/", window.location.origin);
const cadDataRoot = new URL("/cad-data/", window.location.origin);
const workerUrls = {
  dwgParser: new URL("libredwg-parser-worker.js", assetRoot).href,
  mtextRender: new URL("mtext-renderer-worker.js", assetRoot).href
};

let manager;
let initializing;
let currentSide = new URLSearchParams(window.location.search).get("side") || "cad";
let boundView;
let suppressViewBroadcast = false;
let viewPostQueued = false;
let markerTimer;

function preventBrowserMiddleMouse(event) {
  if (event.button !== 1) return;
  event.preventDefault();
}

document.addEventListener("mousedown", preventBrowserMiddleMouse, { capture: true, passive: false });
document.addEventListener("auxclick", preventBrowserMiddleMouse, { capture: true, passive: false });

function bindViewSync() {
  const view = manager?.curView;
  if (!view || boundView === view) return;
  boundView = view;
  view.events.viewChanged.addEventListener(() => {
    if (suppressViewBroadcast || viewPostQueued) return;
    viewPostQueued = true;
    requestAnimationFrame(() => {
      viewPostQueued = false;
      const activeView = manager?.curView;
      const layoutView = activeView?.activeLayoutView;
      if (!activeView || !layoutView) return;
      window.parent.postMessage({
        type: "cad-renderer-view-changed",
        side: currentSide,
        center: { x: activeView.center.x, y: activeView.center.y },
        zoom: layoutView.trCamera.zoom
      }, window.location.origin);
    });
  });
}

function applyCamera(center, zoom) {
  const view = manager?.curView;
  if (!view || !center || !Number.isFinite(zoom) || zoom <= 0) return;
  suppressViewBroadcast = true;
  view.flyTo({ x: center.x, y: center.y }, zoom);
  requestAnimationFrame(() => {
    suppressViewBroadcast = false;
  });
}

function focusLocation(center) {
  const zoom = manager?.curView?.activeLayoutView?.trCamera?.zoom;
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  applyCamera(center, zoom);
  focusMarker.hidden = false;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => {
    focusMarker.hidden = true;
  }, 1600);
}

function showStatus(message) {
  statusElement.textContent = message;
  statusElement.hidden = !message;
}

async function initialize() {
  if (manager) return manager;
  if (initializing) return initializing;

  initializing = (async () => {
    AcDbDatabaseConverterManager.instance.register(
      AcDbFileType.DWG,
      new AcDbLibreDwgConverter({
        convertByEntityType: false,
        useWorker: true,
        parserWorkerUrl: workerUrls.dwgParser
      })
    );
    manager = AcApDocManager.createInstance({
      container,
      autoResize: true,
      busyIndicatorHost: document.body,
      baseUrl: cadDataRoot.href,
      preloadDefaultFonts: false,
      webworkerFileUrls: workerUrls
    });
    await manager.loadDefaultFonts(["Noto Sans CJK KR"]);
    showStatus("");
    return manager;
  })();

  return initializing;
}

async function openDrawing(message) {
  const docManager = await initialize();
  currentSide = message.side || currentSide;
  showStatus(`${message.name} 불러오는 중…`);
  const isDwg = message.name.toLowerCase().endsWith(".dwg");
  if (isDwg && !(await docManager.areWorkersReady())) {
    throw new Error("LibreDWG Worker 또는 WebAssembly 파일에 접근할 수 없습니다.");
  }
  const opened = await docManager.openDocument(message.name, message.buffer, {
    minimumChunkSize: 1000,
    readOnly: true
  });
  if (opened === false) throw new Error("도면을 열지 못했습니다.");
  docManager.sendStringToExecute("zoom\nall");
  bindViewSync();
  showStatus("");
  window.parent.postMessage({
    type: "cad-renderer-loaded",
    side: message.side,
    name: message.name
  }, window.location.origin);
}

window.addEventListener("message", async event => {
  if (event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  try {
    if (message.type === "cad-renderer-load") await openDrawing(message);
    if (message.type === "cad-renderer-fit") {
      const docManager = await initialize();
      docManager.sendStringToExecute("zoom\nall");
    }
    if (message.type === "cad-renderer-focus") {
      await initialize();
      focusLocation(message.center);
    }
    if (message.type === "cad-renderer-apply-view") {
      await initialize();
      applyCamera(message.center, message.zoom);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showStatus(`렌더링 실패: ${detail}`);
    window.parent.postMessage({ type: "cad-renderer-error", side: message.side, detail }, window.location.origin);
  }
});

initialize()
  .then(() => window.parent.postMessage({ type: "cad-renderer-ready" }, window.location.origin))
  .catch(error => showStatus(`초기화 실패: ${error.message}`));
