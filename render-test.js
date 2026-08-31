const fileInput = document.querySelector("#renderFile");
const frame = document.querySelector("#renderFrame");
const statusElement = document.querySelector("#renderStatus");
const fitButton = document.querySelector("#renderFitBtn");
const reloadButton = document.querySelector("#renderReloadBtn");

let selectedFile;
let rendererReady = false;
let startedAt = 0;

function setStatus(message, kind) {
  statusElement.textContent = message;
  statusElement.className = `render-status ${kind}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function renderSelectedFile() {
  if (!selectedFile || !rendererReady || !frame.contentWindow) return;
  setStatus("도면을 해석하고 렌더링하는 중…", "loading");
  document.querySelector("#renderDuration").textContent = "측정 중";
  fitButton.disabled = true;
  reloadButton.disabled = true;
  startedAt = performance.now();
  const buffer = await selectedFile.arrayBuffer();
  frame.contentWindow.postMessage({
    type: "cad-renderer-load",
    side: "test",
    name: selectedFile.name,
    buffer
  }, window.location.origin, [buffer]);
}

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0];
  if (!selectedFile) return;
  const extension = selectedFile.name.split(".").pop()?.toUpperCase() || "-";
  document.querySelector("#renderFileName").textContent = selectedFile.name;
  document.querySelector("#renderFormat").textContent = extension;
  document.querySelector("#renderSize").textContent = formatBytes(selectedFile.size);
  void renderSelectedFile();
});

fitButton.addEventListener("click", () => {
  frame.contentWindow?.postMessage({ type: "cad-renderer-fit", side: "test" }, window.location.origin);
});

reloadButton.addEventListener("click", () => void renderSelectedFile());

window.addEventListener("message", event => {
  if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "cad-renderer-ready") {
    rendererReady = true;
    setStatus("렌더러 준비 완료", "ready");
    if (selectedFile) void renderSelectedFile();
  }

  if (message.type === "cad-renderer-loaded") {
    const duration = performance.now() - startedAt;
    document.querySelector("#renderDuration").textContent = `${duration.toLocaleString("ko-KR", { maximumFractionDigits: 0 })} ms`;
    setStatus("렌더링 완료", "success");
    fitButton.disabled = false;
    reloadButton.disabled = false;
  }

  if (message.type === "cad-renderer-error") {
    const duration = performance.now() - startedAt;
    document.querySelector("#renderDuration").textContent = `${duration.toFixed(0)} ms 후 실패`;
    setStatus(`렌더링 실패: ${message.detail}`, "error");
    reloadButton.disabled = false;
  }
});
