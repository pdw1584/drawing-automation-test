const DB_NAME = "drawing-automation-equipment";
const STORE_NAME = "drawings";
const ANALYSIS_VERSION = 8;

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
let selectedEquipmentCategory = "";

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
    .replace(/%%[A-Za-z]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/\?{2,}/g, "")
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
  return {priority: Number.MAX_SAFE_INTEGER, category: ""}
}

function equipmentLabel(sourceName, classification) {
  const upperName = sourceName.toLocaleUpperCase("ko-KR");
  const definition = equipmentPriorities[classification.priority];
  const latinAliases = (definition?.aliases || []).filter(alias => /^[A-Z0-9 /-]+$/i.test(alias));
  const tags = upperName.match(/[A-Z0-9]+(?:[-_][A-Z0-9]+)+/g) || [];
  const tagged = tags.find(tag => latinAliases.some(alias => {
    const token = alias.toUpperCase().replace(/[\s/]/g, "");
    return token.length >= 2 && tag.replace(/[_-]/g, "").includes(token)
  }));
  return tagged || classification.category
}

const PANEL_LINK_CATEGORIES = new Set(["UPS", "STS", "Battery", "변압기", "HV", "LV", "RF"]);

function panelNameFromText(value) {
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const matches = text.match(/(?:B?\d{1,2}F|RF|PH)(?:\s*[-_/]\s*[A-Z0-9]{1,8}){1,4}/g) || [];
  const match = matches.find(name => !/(?:UPS|STS|BAT|TR)/.test(name));
  return match ? match.replace(/\s*[-_/]\s*/g, "-") : ""
}

function rfPanelNameFromText(value) {
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const match = text.match(/(?:^|[^A-Z0-9])(\d{1,3}[A-Z](?:\s*[-_/]\s*\d{1,3})?)(?:[^A-Z0-9]|$)/);
  return match ? match[1].replace(/\s*[-_/]\s*/g, "-") : ""
}

function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function attachNearbyPanelNames(equipment, textItems) {
  const panels = (textItems || []).map(item => ({...item, panelName: panelNameFromText(item.text || "")}))
    .filter(item => item.panelName);
  const rfPanels = (textItems || []).map(item => ({
    ...item,
    panelName: panelNameFromText(item.text || "") ? "" : rfPanelNameFromText(item.text || "")
  }))
    .filter(item => item.panelName);
  if (!panels.length && !rfPanels.length) return equipment;

  const linkable = equipment.filter(item => PANEL_LINK_CATEGORIES.has(item.category));
  for (const item of linkable) {
    const panelCandidates = item.category === "RF" ? rfPanels : panels;
    const nearestPanel = panelCandidates.map(panel => ({panel, distance: distanceBetween(item, panel)}))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearestPanel) continue;

    const nearestPeerDistance = linkable.filter(peer => peer !== item && distanceBetween(item, peer) > .001)
      .reduce((nearest, peer) => Math.min(nearest, distanceBetween(item, peer)), Number.POSITIVE_INFINITY);
    const textScaleLimit = Math.max(item.height || 0, nearestPanel.panel.h || 0, 1) * 100;
    const peerLimit = Number.isFinite(nearestPeerDistance) ? nearestPeerDistance * 2 : 0;
    if (nearestPanel.distance > Math.max(textScaleLimit, peerLimit)) continue;

    item.panelName = nearestPanel.panel.panelName;
    item.name = `${item.name} · ${item.panelName}`
  }
  return equipment
}

function equipmentCandidates(textItems) {
  const seen = new Set(), equipment = [];
  for (const item of textItems || []) {
    const name = cleanCadText(item.text || "");
    if (name.length < 2 || name.length > 100) continue;
    if (!/[A-Za-z가-힣]/.test(name) || /^[-+Ø⌀]?\d+(?:[.,x×*/-]\d+)*\s*(?:mm|cm|m|a|v|kw|t)?$/i.test(name)) continue;
    const key = `${name.toUpperCase()}:${item.x.toFixed(2)}:${item.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    const classification = equipmentPriority(name);
    if (classification.priority === Number.MAX_SAFE_INTEGER) continue;
    const label = equipmentLabel(name, classification);
    seen.add(key);
    equipment.push({name: label, sourceName: name, x: item.x, y: item.y, width: item.w, height: item.h, ...classification})
  }
  return attachNearbyPanelNames(equipment, textItems)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}))
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
      <small>${escapeHtml(drawing.description || "설명 없음")} · 문서 기준 장비 ${(drawing.equipment || []).filter(item => item.priority < Number.MAX_SAFE_INTEGER).length.toLocaleString("ko-KR")}개</small>
    </button>
  `).join("") : '<div class="empty-row">등록된 도면이 없습니다.</div>';
  for (const card of document.querySelectorAll(".drawing-card")) {
    card.onclick = () => selectDrawing(card.dataset.id)
  }
}

function renderEquipmentList() {
  if (!activeDrawing) {
    document.querySelector("#equipmentFilters").innerHTML = "";
    document.querySelector("#equipmentList").innerHTML = '<div class="empty-row">선택된 도면이 없습니다.</div>';
    return
  }
  const query = searchInput.value.trim().toLocaleUpperCase("ko-KR");
  const documentedEquipment = activeDrawing.equipment.filter(item => item.priority < Number.MAX_SAFE_INTEGER);
  const categoryCounts = new Map();
  for (const item of documentedEquipment) categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
  if (selectedEquipmentCategory && !categoryCounts.has(selectedEquipmentCategory)) selectedEquipmentCategory = "";
  const categories = [...categoryCounts].sort((a, b) => {
    const firstPriority = documentedEquipment.find(item => item.category === a[0])?.priority ?? Number.MAX_SAFE_INTEGER;
    const secondPriority = documentedEquipment.find(item => item.category === b[0])?.priority ?? Number.MAX_SAFE_INTEGER;
    return firstPriority - secondPriority || a[0].localeCompare(b[0], "ko")
  });
  document.querySelector("#equipmentFilters").innerHTML = `
    <button class="equipment-filter ${selectedEquipmentCategory ? "" : "active"}" data-category="">전체 <span>${documentedEquipment.length.toLocaleString("ko-KR")}</span></button>
    ${categories.map(([category, count]) => `<button class="equipment-filter ${selectedEquipmentCategory === category ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)} <span>${count.toLocaleString("ko-KR")}</span></button>`).join("")}
  `;
  const rows = documentedEquipment.filter(item => {
    const categoryMatched = !selectedEquipmentCategory || item.category === selectedEquipmentCategory;
    const queryMatched = !query || `${item.name} ${item.category}`.toLocaleUpperCase("ko-KR").includes(query);
    return categoryMatched && queryMatched
  });
  const filtered = selectedEquipmentCategory || query;
  document.querySelector("#equipmentSummary").textContent = `${activeDrawing.displayName} · 문서 기준 장비 ${documentedEquipment.length.toLocaleString("ko-KR")}개${filtered ? ` · 필터 결과 ${rows.length.toLocaleString("ko-KR")}개` : ""}`;
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
  for (const filter of document.querySelectorAll(".equipment-filter")) {
    filter.onclick = () => {
      selectedEquipmentCategory = filter.dataset.category || "";
      renderEquipmentList()
    }
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
  selectedEquipmentCategory = "";
  document.querySelector("#activeDrawingName").textContent = activeDrawing.displayName;
  document.querySelector("#activeDrawingDescription").textContent = `${activeDrawing.originalName} · ${formatBytes(activeDrawing.file.size)} · ${activeDrawing.codepage || "코드페이지 미확인"}${activeDrawing.description ? ` · ${activeDrawing.description}` : ""}`;
  deleteButton.disabled = false;
  reanalyzeButton.disabled = false;
  searchInput.disabled = false;
  searchInput.value = "";
  renderDrawingList();
  renderEquipmentList();
  await renderActiveDrawing();
  if (activeDrawing.analysisVersion !== ANALYSIS_VERSION) void reanalyzeActiveDrawing(true)
}

async function reanalyzeActiveDrawing(automatic = false) {
  if (!activeDrawing || reanalyzeButton.disabled) return;
  reanalyzeButton.disabled = true;
  document.querySelector("#equipmentSummary").textContent = automatic ? "기존 장비 목록을 문서 기준으로 자동 정리하고 있습니다…" : "한글 코드페이지와 문서 우선순위 기준으로 장비를 다시 분석하고 있습니다…";
  try {
    const analysis = await analyzeDxf(activeDrawing.file);
    activeDrawing.equipment = analysis.equipment;
    activeDrawing.codepage = analysis.codepage;
    activeDrawing.analysisVersion = ANALYSIS_VERSION;
    await saveDrawing(activeDrawing);
    renderDrawingList();
    renderEquipmentList()
  } catch (error) {
    document.querySelector("#equipmentSummary").textContent = `장비 재분석 실패: ${error.message}`
  } finally {
    reanalyzeButton.disabled = false
  }
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
      analysisVersion: ANALYSIS_VERSION,
      createdAt: new Date().toISOString()
    };
    await saveDrawing(drawing);
    drawings.unshift(drawing);
    selectedFile = undefined;
    fileInput.value = "";
    displayNameInput.value = "";
    descriptionInput.value = "";
    document.querySelector("#selectedFileName").textContent = "대용량 파일도 브라우저에서 직접 처리합니다.";
    document.querySelector("#registerStatus").textContent = `등록 완료: 문서 기준 장비 ${drawing.equipment.length.toLocaleString("ko-KR")}개를 찾았습니다.`;
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
reanalyzeButton.onclick = () => reanalyzeActiveDrawing();
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
  document.querySelector("#equipmentSummary").textContent = "도면을 선택하면 문서 기준 장비가 표시됩니다.";
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
      if (drawing.analysisVersion === ANALYSIS_VERSION) {
        drawing.equipment = (drawing.equipment || [])
          .filter(item => item.priority < Number.MAX_SAFE_INTEGER)
          .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}));
        continue
      }
      drawing.equipment = (drawing.equipment || []).map(item => {
        const sourceName = cleanCadText(item.sourceName || item.name || ""), classification = equipmentPriority(sourceName);
        const baseName = classification.priority < Number.MAX_SAFE_INTEGER ? equipmentLabel(sourceName, classification) : "";
        return {...item, sourceName, name: item.panelName ? `${baseName} · ${item.panelName}` : baseName, ...classification}
      }).filter(item => item.priority < Number.MAX_SAFE_INTEGER)
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}))
    }
    renderDrawingList();
    if (drawings[0]) await selectDrawing(drawings[0].id)
  } catch (error) {
    document.querySelector("#registerStatus").textContent = `브라우저 저장소를 열지 못했습니다: ${error.message}`
  }
}

void initialize();
