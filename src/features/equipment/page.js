import {
  analyzeDxf,
  cleanCadText,
  configureEquipmentPriorities,
  equipmentLabel,
  equipmentPriority
} from "./analysis.js";
import {getDrawings, removeDrawing, saveDrawing} from "./store.js";
import {escapeHtml, formatBytes} from "../../shared/ui-utils.js";

const ANALYSIS_VERSION = 23;

// 분석 규칙 버전이다. 장비/판넬 매칭 규칙이 바뀌면 값을 올려 기존 도면을
// 최초 선택 시 한 번만 재분석한다. IndexedDB 자체의 스키마 버전과는 별개다.

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
  equipmentPriorities = await response.json();
  configureEquipmentPriorities(equipmentPriorities)
}

function setStatus(message, kind = "waiting") {
  statusElement.textContent = message;
  statusElement.className = `render-status ${kind}`
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
  // 고정 필터가 아니라 현재 도면에서 실제 검출된 분류만 버블 버튼으로 만든다.
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
  // 도면을 연속 선택할 때 이전 파일 읽기가 늦게 끝나 새 도면을 덮지 않도록 한다.
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
    // equipment와 analysisVersion을 한 transaction에 저장하고 commit 완료 후 갱신한다.
    // 그래야 새로고침 직후에도 판넬명이 포함된 최신 분석 결과가 유지된다.
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
      // 현재 버전 결과는 저장된 판넬명을 그대로 복원한다. 여기서 다시 표준 장비명으로
      // 계산하면 `UPS · 5F-1D-3`의 판넬 부분이 새로고침 때 사라지게 된다.
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
