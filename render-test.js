const DB_NAME = "drawing-automation-equipment";
const STORE_NAME = "drawings";

const fileInput = document.querySelector("#renderFile");
const frame = document.querySelector("#renderFrame");
const statusElement = document.querySelector("#renderStatus");
const fitButton = document.querySelector("#renderFitBtn");
const deleteButton = document.querySelector("#deleteDrawingBtn");
const reanalyzeButton = document.querySelector("#reanalyzeDrawingBtn");
const registerButton = document.querySelector("#registerDrawingBtn");
const displayNameInput = document.querySelector("#drawingDisplayName");
const descriptionInput = document.querySelector("#drawingDescription");
const searchInput = document.querySelector("#equipmentSearch");

let selectedFile;
let drawings = [];
let activeDrawing;
let rendererReady = false;
let renderGeneration = 0;
let startedAt = 0;
let equipmentPriorities = [];

async function loadEquipmentPriorities() {
  const response = await fetch("/equipment-priority.json", {cache: "no-store"});
  if (!response.ok) throw new Error("장비 우선순위 사전을 불러오지 못했습니다.");
  equipmentPriorities = await response.json()
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {keyPath: "id"})
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error)
  })
}

async function useStore(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => reject(transaction.error)
  })
}

const getDrawings = () => useStore("readonly", store => store.getAll());
const saveDrawing = drawing => useStore("readwrite", store => store.put(drawing));
const removeDrawing = id => useStore("readwrite", store => store.delete(id));

function setStatus(message, kind = "waiting") {
  statusElement.textContent = message;
  statusElement.className = `render-status ${kind}`
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character])
}

function cleanCadText(value) {
  return value
    .replace(/\\P/gi, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/%%[dpc]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function equipmentPriority(name) {
  const upperName = name.toLocaleUpperCase("ko-KR");
  for (let index = 0; index < equipmentPriorities.length; index++) {
    const definition = equipmentPriorities[index];
    for (const rawAlias of definition.aliases) {
      const alias = rawAlias.toLocaleUpperCase("ko-KR").trim();
      const matched = alias.length <= 3
        ? new RegExp(`(^|[^A-Z0-9가-힣])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9가-힣]|$)`).test(upperName)
        : upperName.replace(/[\s_-]/g, "").includes(alias.replace(/[\s_-]/g, ""));
      if (matched) return {priority: index, category: definition.name}
    }
  }
  return {priority: Number.MAX_SAFE_INTEGER, category: "기타 후보"}
}

function equipmentCandidates(textItems) {
  const seen = new Set(), equipment = [];
  for (const item of textItems || []) {
    const name = cleanCadText(item.text || "");
    if (name.length < 2 || name.length > 100) continue;
    if (!/[A-Za-z가-힣]/.test(name) || /^[-+Ø⌀]?\d+(?:[.,x×*/-]\d+)*\s*(?:mm|cm|m|a|v|kw|t)?$/i.test(name)) continue;
    const key = `${name.toUpperCase()}:${item.x.toFixed(2)}:${item.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    equipment.push({name, x: item.x, y: item.y, width: item.w, height: item.h, ...equipmentPriority(name)})
  }
  return equipment.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}))
}

function analyzeDxf(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./review-dxf-worker.js", import.meta.url), {type: "module"});
    worker.onmessage = event => {
      worker.terminate();
      if (event.data?.error) reject(new Error(event.data.error));
      else resolve({codepage: event.data.codepage, equipment: equipmentCandidates(event.data.preview?.textItems)})
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || "DXF 장비명 분석 Worker 실행에 실패했습니다."))
    };
    worker.postMessage({file})
  })
}

function updateRegisterButton() {
  registerButton.disabled = !selectedFile || !displayNameInput.value.trim()
}

function renderDrawingList() {
  document.querySelector("#drawingCount").textContent = `${drawings.length}개`;
  document.querySelector("#drawingList").innerHTML = drawings.length ? drawings.map(drawing => `
    <button class="drawing-card ${drawing.id === activeDrawing?.id ? "active" : ""}" data-id="${drawing.id}">
      <strong>${escapeHtml(drawing.displayName)}</strong>
      <span>${escapeHtml(drawing.originalName)}</span>
      <small>${escapeHtml(drawing.description || "설명 없음")} · 장비 ${drawing.equipment.length.toLocaleString("ko-KR")}개</small>
    </button>
  `).join("") : '<div class="empty-row">등록된 도면이 없습니다.</div>';
  for (const card of document.querySelectorAll(".drawing-card")) {
    card.onclick = () => selectDrawing(card.dataset.id)
  }
}

function renderEquipmentList() {
  if (!activeDrawing) {
    document.querySelector("#equipmentList").innerHTML = '<div class="empty-row">선택된 도면이 없습니다.</div>';
    return
  }
  const query = searchInput.value.trim().toLocaleUpperCase("ko-KR");
  const rows = activeDrawing.equipment.filter(item => !query || item.name.toLocaleUpperCase("ko-KR").includes(query));
  document.querySelector("#equipmentSummary").textContent = `${activeDrawing.displayName} · 장비 후보 ${activeDrawing.equipment.length.toLocaleString("ko-KR")}개${query ? ` · 검색 결과 ${rows.length.toLocaleString("ko-KR")}개` : ""}`;
  document.querySelector("#equipmentList").innerHTML = rows.length ? rows.slice(0, 5000).map((item, index) => `
    <button class="equipment-row" data-index="${activeDrawing.equipment.indexOf(item)}">
      <span class="equipment-number">${index + 1}</span>
      <strong>${escapeHtml(item.name)}${Number.isFinite(item.priority) && item.priority < Number.MAX_SAFE_INTEGER ? `<em>${escapeHtml(item.category)}</em>` : ""}</strong>
      <span>X ${item.x.toFixed(2)} · Y ${item.y.toFixed(2)}</span>
    </button>
  `).join("") : '<div class="empty-row">해당 장비명이 없습니다.</div>';
  for (const row of document.querySelectorAll(".equipment-row")) {
    row.onclick = () => focusEquipment(activeDrawing.equipment[Number(row.dataset.index)], row)
  }
}

function focusEquipment(equipment, row) {
  frame.contentWindow?.postMessage({
    type: "cad-renderer-focus",
    side: "equipment",
    center: {x: equipment.x, y: equipment.y}
  }, window.location.origin);
  document.querySelectorAll(".equipment-row.active").forEach(item => item.classList.remove("active"));
  row.classList.add("active")
}

async function renderActiveDrawing() {
  if (!activeDrawing || !rendererReady) return;
  const generation = ++renderGeneration;
  setStatus("도면을 불러오는 중…", "loading");
  fitButton.disabled = true;
  startedAt = performance.now();
  const buffer = await activeDrawing.file.arrayBuffer();
  if (generation !== renderGeneration) return;
  frame.contentWindow.postMessage({
    type: "cad-renderer-load",
    side: "equipment",
    name: activeDrawing.originalName,
    buffer
  }, window.location.origin, [buffer])
}

async function selectDrawing(id) {
  activeDrawing = drawings.find(drawing => drawing.id === id);
  if (!activeDrawing) return;
  document.querySelector("#activeDrawingName").textContent = activeDrawing.displayName;
  document.querySelector("#activeDrawingDescription").textContent = `${activeDrawing.originalName} · ${formatBytes(activeDrawing.file.size)} · ${activeDrawing.codepage || "코드페이지 미확인"}${activeDrawing.description ? ` · ${activeDrawing.description}` : ""}`;
  deleteButton.disabled = false;
  reanalyzeButton.disabled = false;
  searchInput.disabled = false;
  searchInput.value = "";
  renderDrawingList();
  renderEquipmentList();
  await renderActiveDrawing()
}

async function registerSelectedDrawing() {
  if (!selectedFile || !displayNameInput.value.trim()) return;
  registerButton.disabled = true;
  document.querySelector("#registerStatus").textContent = "DXF에서 장비 이름과 위치를 분석하고 있습니다…";
  try {
    if (!equipmentPriorities.length) await loadEquipmentPriorities();
    if (navigator.storage?.persist) await navigator.storage.persist();
    const analysis = await analyzeDxf(selectedFile);
    const drawing = {
      id: crypto.randomUUID(),
      originalName: selectedFile.name,
      displayName: displayNameInput.value.trim(),
      description: descriptionInput.value.trim(),
      file: selectedFile,
      equipment: analysis.equipment,
      codepage: analysis.codepage,
      createdAt: new Date().toISOString()
    };
    await saveDrawing(drawing);
    drawings.unshift(drawing);
    selectedFile = undefined;
    fileInput.value = "";
    displayNameInput.value = "";
    descriptionInput.value = "";
    document.querySelector("#selectedFileName").textContent = "대용량 파일도 브라우저에서 직접 처리합니다.";
    document.querySelector("#registerStatus").textContent = `등록 완료: 장비 후보 ${drawing.equipment.length.toLocaleString("ko-KR")}개를 찾았습니다.`;
    updateRegisterButton();
    await selectDrawing(drawing.id)
  } catch (error) {
    document.querySelector("#registerStatus").textContent = `등록 실패: ${error.message}`;
    updateRegisterButton()
  }
}

fileInput.onchange = () => {
  selectedFile = fileInput.files?.[0];
  if (!selectedFile) return;
  displayNameInput.value ||= selectedFile.name.replace(/\.dxf$/i, "");
  document.querySelector("#selectedFileName").textContent = `${selectedFile.name} · ${formatBytes(selectedFile.size)}`;
  updateRegisterButton()
};

displayNameInput.oninput = updateRegisterButton;
registerButton.onclick = registerSelectedDrawing;
fitButton.onclick = () => frame.contentWindow?.postMessage({type: "cad-renderer-fit", side: "equipment"}, window.location.origin);
searchInput.oninput = renderEquipmentList;
reanalyzeButton.onclick = async () => {
  if (!activeDrawing) return;
  reanalyzeButton.disabled = true;
  document.querySelector("#equipmentSummary").textContent = "한글 코드페이지와 문서 우선순위 기준으로 장비를 다시 분석하고 있습니다…";
  try {
    const analysis = await analyzeDxf(activeDrawing.file);
    activeDrawing.equipment = analysis.equipment;
    activeDrawing.codepage = analysis.codepage;
    await saveDrawing(activeDrawing);
    renderDrawingList();
    renderEquipmentList()
  } catch (error) {
    document.querySelector("#equipmentSummary").textContent = `장비 재분석 실패: ${error.message}`
  } finally {
    reanalyzeButton.disabled = false
  }
};
deleteButton.onclick = async () => {
  if (!activeDrawing || !confirm(`“${activeDrawing.displayName}” 도면을 브라우저 저장소에서 삭제할까요?`)) return;
  const deletedId = activeDrawing.id;
  await removeDrawing(deletedId);
  drawings = drawings.filter(drawing => drawing.id !== deletedId);
  activeDrawing = undefined;
  deleteButton.disabled = true;
  reanalyzeButton.disabled = true;
  fitButton.disabled = true;
  searchInput.disabled = true;
  document.querySelector("#activeDrawingName").textContent = "도면을 선택하세요";
  document.querySelector("#activeDrawingDescription").textContent = "";
  document.querySelector("#equipmentSummary").textContent = "도면을 선택하면 장비 후보가 표시됩니다.";
  renderDrawingList();
  renderEquipmentList();
  setStatus("도면을 선택하세요", "waiting")
};

window.addEventListener("message", event => {
  if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "cad-renderer-ready") {
    rendererReady = true;
    setStatus("렌더러 준비 완료", "ready");
    if (activeDrawing) void renderActiveDrawing()
  }
  if (message.type === "cad-renderer-loaded") {
    const duration = performance.now() - startedAt;
    setStatus(`렌더링 완료 · ${duration.toLocaleString("ko-KR", {maximumFractionDigits: 0})}ms`, "success");
    fitButton.disabled = false
  }
  if (message.type === "cad-renderer-error") {
    setStatus(`렌더링 실패: ${message.detail}`, "error")
  }
});

async function initialize() {
  try {
    await loadEquipmentPriorities();
    drawings = (await getDrawings()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const drawing of drawings) {
      drawing.equipment = (drawing.equipment || []).map(item => ({...item, ...equipmentPriority(item.name)}))
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}))
    }
    renderDrawingList();
    if (drawings[0]) await selectDrawing(drawings[0].id)
  } catch (error) {
    document.querySelector("#registerStatus").textContent = `브라우저 저장소를 열지 못했습니다: ${error.message}`
  }
}

void initialize();
