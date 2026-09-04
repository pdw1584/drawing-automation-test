import {
  analyzeDxf,
  cleanCadText,
  configureEquipmentPriorities,
  equipmentLabel,
  equipmentPriority
} from "./analysis.js";
import {getDrawings, removeDrawing, saveDrawing} from "./store.js";
import {
  applyEquipmentCorrections,
  equipmentCorrectionKey,
  isPendingEquipmentIssue,
  updateEquipmentCorrections
} from "./corrections.js";
import {
  combineCustomEquipmentDefinitions,
  createEquipmentDictionaryExport,
  equipmentDictionaryRevision,
  loadCustomEquipmentDefinitions,
  mergeEquipmentDefinitions,
  parseEquipmentDictionaryImport,
  restoreCustomEquipmentDefinitions,
  saveCustomEquipmentDefinitions
} from "./dictionary.js";
import {
  applyEquipmentWorkbookRows,
  buildEquipmentReport,
  createEquipmentWorkbook,
  parseEquipmentWorkbook
} from "./report.js";
import {moveDrawing, normalizeDrawingOrder} from "./drawing-order.js";
import {escapeHtml, formatBytes} from "../../shared/ui-utils.js";

const ANALYSIS_VERSION = 25;

// 분석 규칙 버전이다. 장비/판넬 매칭 규칙이 바뀌면 값을 올려 기존 도면을
// 최초 선택 시 한 번만 재분석한다. IndexedDB 자체의 스키마 버전과는 별개다.

const fileInput = document.querySelector("#renderFile");
const frame = document.querySelector("#renderFrame");
const statusElement = document.querySelector("#renderStatus");
const fitButton = document.querySelector("#renderFitBtn");
const deleteButton = document.querySelector("#deleteDrawingBtn");
const reanalyzeButton = document.querySelector("#reanalyzeDrawingBtn");
const reanalyzeAllButton = document.querySelector("#reanalyzeAllDrawingsBtn");
const registerButton = document.querySelector("#registerDrawingBtn");
const displayNameInput = document.querySelector("#drawingDisplayName");
const descriptionInput = document.querySelector("#drawingDescription");
const searchInput = document.querySelector("#equipmentSearch");
const correctionDialog = document.querySelector("#equipmentCorrectionDialog");
const correctionForm = document.querySelector("#equipmentCorrectionForm");
const correctedPanelInput = document.querySelector("#correctedPanelName");
const excludeEquipmentInput = document.querySelector("#excludeEquipment");
const reviewStatusInput = document.querySelector("#equipmentReviewStatus");
const dictionaryDialog = document.querySelector("#equipmentDictionaryDialog");
const dictionaryForm = document.querySelector("#equipmentDictionaryForm");
const dictionaryNameInput = document.querySelector("#dictionaryEquipmentName");
const dictionaryAliasesInput = document.querySelector("#dictionaryEquipmentAliases");
const drawingEditDialog = document.querySelector("#drawingEditDialog");
const drawingEditForm = document.querySelector("#drawingEditForm");
const editingDrawingDisplayName = document.querySelector("#editingDrawingDisplayName");
const editingDrawingDescription = document.querySelector("#editingDrawingDescription");

let selectedFile;
let drawings = [];
let activeDrawing;
let rendererReady = false;
let renderGeneration = 0;
let startedAt = 0;
let equipmentPriorities = [];
let builtInEquipmentPriorities = [];
let customEquipmentDefinitions = [];
let selectedEquipmentCategory = "";
let correctingEquipment;
let visibleEquipmentRows = [];
const selectedEquipmentKeys = new Set();
let batchAnalysisRunning = false;
let batchAnalysisCancelled = false;
let editingDrawing;
let drawingListEditMode = false;

function baseEquipmentLabel(item) {
  const sourceName = cleanCadText(item.sourceName || item.name || "");
  const classification = equipmentPriority(sourceName);
  return classification.priority < Number.MAX_SAFE_INTEGER
    ? equipmentLabel(sourceName, classification)
    : item.baseName || sourceName
}

function applyDrawingCorrections(drawing) {
  drawing.equipmentCorrections ||= {};
  drawing.equipment = applyEquipmentCorrections(
    drawing.equipment || [],
    drawing.equipmentCorrections,
    baseEquipmentLabel
  ).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}));
  return drawing.equipment
}

async function loadEquipmentPriorities() {
  const response = await fetch("/equipment-priority.json", {cache: "no-store"});
  if (!response.ok) throw new Error("장비 우선순위 사전을 불러오지 못했습니다.");
  builtInEquipmentPriorities = await response.json();
  customEquipmentDefinitions = loadCustomEquipmentDefinitions();
  equipmentPriorities = mergeEquipmentDefinitions(builtInEquipmentPriorities, customEquipmentDefinitions);
  configureEquipmentPriorities(equipmentPriorities)
}

function renderCustomEquipmentRules() {
  const list = document.querySelector("#customEquipmentRuleList");
  list.innerHTML = customEquipmentDefinitions.length ? customEquipmentDefinitions.map((definition, index) => `
    <div class="custom-equipment-rule">
      <div><strong>${escapeHtml(definition.name)}</strong><span>${definition.aliases.map(escapeHtml).join(", ")}</span></div>
      <button type="button" class="danger" data-rule-index="${index}">삭제</button>
    </div>
  `).join("") : '<div class="empty-row">사용자가 등록한 검출 규칙이 없습니다.</div>';
  for (const button of list.querySelectorAll("[data-rule-index]")) {
    button.onclick = () => void removeCustomEquipmentRule(Number(button.dataset.ruleIndex))
  }
}

function openEquipmentDictionary() {
  renderCustomEquipmentRules();
  dictionaryDialog.showModal();
  dictionaryNameInput.focus()
}

async function refreshDictionaryAnalysis() {
  equipmentPriorities = mergeEquipmentDefinitions(builtInEquipmentPriorities, customEquipmentDefinitions);
  configureEquipmentPriorities(equipmentPriorities);
  if (activeDrawing) await reanalyzeActiveDrawing()
}

function downloadTextFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url)
}

function exportEquipmentDictionary() {
  downloadTextFile(
    createEquipmentDictionaryExport(customEquipmentDefinitions),
    `장비-검출-사전-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json;charset=utf-8"
  )
}

async function importEquipmentDictionary(file) {
  const status = document.querySelector("#equipmentDictionaryTransferStatus");
  try {
    const incoming = parseEquipmentDictionaryImport(await file.text());
    const mode = document.querySelector("#equipmentDictionaryImportMode").value;
    const currentNames = new Set(customEquipmentDefinitions.map(item => item.name.toLocaleUpperCase("ko-KR")));
    const conflicts = incoming.filter(item => currentNames.has(item.name.toLocaleUpperCase("ko-KR"))).length;
    customEquipmentDefinitions = saveCustomEquipmentDefinitions(
      combineCustomEquipmentDefinitions(customEquipmentDefinitions, incoming, mode)
    );
    renderCustomEquipmentRules();
    status.textContent = `${incoming.length.toLocaleString("ko-KR")}개 규칙을 ${mode === "replace" ? "교체" : "병합"}했습니다${conflicts ? ` · 같은 분류 ${conflicts.toLocaleString("ko-KR")}개 처리` : ""}.`;
    await refreshDictionaryAnalysis()
  } catch (error) {
    status.textContent = `가져오기 실패: ${error.message}`
  }
}

async function restoreEquipmentDictionary() {
  const status = document.querySelector("#equipmentDictionaryTransferStatus");
  const restored = restoreCustomEquipmentDefinitions();
  if (!restored) {
    status.textContent = "복구할 이전 사용자 사전이 없습니다.";
    return
  }
  customEquipmentDefinitions = restored;
  renderCustomEquipmentRules();
  status.textContent = `이전 사용자 사전 ${restored.length.toLocaleString("ko-KR")}개를 복구했습니다.`;
  await refreshDictionaryAnalysis()
}

async function saveCustomEquipmentRule() {
  const name = dictionaryNameInput.value.trim();
  const aliases = dictionaryAliasesInput.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean);
  if (!name || !aliases.length) return;
  const sameName = value => value.name.toLocaleUpperCase("ko-KR") === name.toLocaleUpperCase("ko-KR");
  const previous = customEquipmentDefinitions.find(sameName);
  const next = {name, aliases: [...new Set([...(previous?.aliases || []), ...aliases])]};
  customEquipmentDefinitions = saveCustomEquipmentDefinitions([
    ...customEquipmentDefinitions.filter(definition => !sameName(definition)),
    next
  ]);
  dictionaryNameInput.value = "";
  dictionaryAliasesInput.value = "";
  renderCustomEquipmentRules();
  await refreshDictionaryAnalysis()
}

async function removeCustomEquipmentRule(index) {
  const definition = customEquipmentDefinitions[index];
  if (!definition || !confirm(`“${definition.name}” 사용자 검출 규칙을 삭제할까요?`)) return;
  customEquipmentDefinitions = saveCustomEquipmentDefinitions(customEquipmentDefinitions.filter((_, itemIndex) => itemIndex !== index));
  renderCustomEquipmentRules();
  await refreshDictionaryAnalysis()
}

function setStatus(message, kind = "waiting") {
  statusElement.textContent = message;
  statusElement.className = `render-status ${kind}`
}

function updateRegisterButton() {
  registerButton.disabled = !selectedFile || !displayNameInput.value.trim()
}

function equipmentDuplicateKey(item) {
  return `${item.category}|${item.name}`.toLocaleUpperCase("ko-KR")
}

function confidenceLabel(item) {
  return ({high: "높은 신뢰", medium: "보통 신뢰", low: "저신뢰", manual: "수동 확정", unmatched: "미연결"})[item.panelMatchConfidence]
    || (item.panelName ? "신뢰도 미산정" : "미연결")
}

function reviewStatusLabel(item) {
  return ({reviewed: "확인 완료", needs_revision: "수정 필요", unreviewed: "미검토"})[item.reviewStatus] || "미검토"
}

function updateBulkActions() {
  const selectedCount = selectedEquipmentKeys.size;
  document.querySelector("#selectedEquipmentCount").textContent = `${selectedCount.toLocaleString("ko-KR")}개 선택`;
  document.querySelector("#excludeSelectedEquipmentBtn").disabled = !selectedCount;
  document.querySelector("#excludeSelectedEquipmentBtn").textContent = selectedEquipmentCategory === "__excluded__"
    ? "선택 장비 복원"
    : "선택 장비 제외";
  document.querySelector("#markSelectedReviewedBtn").disabled = !selectedCount;
  document.querySelector("#markSelectedUnreviewedBtn").disabled = !selectedCount;
  document.querySelector("#markSelectedNeedsRevisionBtn").disabled = !selectedCount;
  document.querySelector("#clearEquipmentSelectionBtn").disabled = !selectedCount;
  const visibleKeys = visibleEquipmentRows.map(equipmentCorrectionKey);
  const allVisibleSelected = visibleKeys.length && visibleKeys.every(key => selectedEquipmentKeys.has(key));
  document.querySelector("#selectVisibleEquipmentBtn").textContent = allVisibleSelected ? "현재 목록 선택 해제" : "현재 목록 전체 선택";
  document.querySelector("#selectVisibleEquipmentBtn").disabled = !visibleKeys.length
}

async function updateSelectedEquipmentCorrections(changes, confirmation) {
  if (!activeDrawing || !selectedEquipmentKeys.size || (confirmation && !confirm(confirmation))) return;
  activeDrawing.equipmentCorrections = updateEquipmentCorrections(
    activeDrawing.equipment,
    activeDrawing.equipmentCorrections,
    selectedEquipmentKeys,
    changes
  );
  applyDrawingCorrections(activeDrawing);
  await saveDrawing(activeDrawing);
  selectedEquipmentKeys.clear();
  renderDrawingList();
  renderEquipmentList()
}

function renderDrawingList() {
  if (!drawings.length) drawingListEditMode = false;
  document.querySelector("#drawingCount").textContent = `${drawings.length}개`;
  const editModeButton = document.querySelector("#toggleDrawingEditModeBtn");
  editModeButton.disabled = !drawings.length;
  editModeButton.textContent = drawingListEditMode ? "수정 완료" : "목록 수정";
  document.querySelector("#equipmentSummaryBtn").disabled = !drawings.length;
  document.querySelector("#exportEquipmentBtn").disabled = !drawings.length;
  document.querySelector("#importEquipmentFile").disabled = !drawings.length;
  reanalyzeAllButton.disabled = !drawings.length || batchAnalysisRunning;
  document.querySelector("#drawingList").innerHTML = drawings.length ? drawings.map((drawing, index) => `
    <div class="drawing-card-wrap ${drawing.id === activeDrawing?.id ? "active" : ""} ${drawingListEditMode ? "editing" : ""}" data-id="${drawing.id}">
      <button class="drawing-card" type="button">
        <strong>${escapeHtml(drawing.displayName)}</strong>
        <span>${escapeHtml(drawing.originalName)}</span>
        <small>${escapeHtml(drawing.description || "설명 없음")} · 확정 장비 ${(drawing.equipment || []).filter(item => item.priority < Number.MAX_SAFE_INTEGER && !item.userExcluded).length.toLocaleString("ko-KR")}개</small>
      </button>
      ${drawingListEditMode ? `<div class="drawing-card-actions">
        <button type="button" data-drawing-action="up" title="위로 이동" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-drawing-action="down" title="아래로 이동" ${index === drawings.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="drawing-edit-button" data-drawing-action="edit">정보 수정</button>
      </div>` : ""}
    </div>
  `).join("") : '<div class="empty-row">등록된 도면이 없습니다.</div>';
  for (const wrapper of document.querySelectorAll(".drawing-card-wrap")) {
    wrapper.querySelector(".drawing-card").onclick = () => selectDrawing(wrapper.dataset.id);
    for (const button of wrapper.querySelectorAll("[data-drawing-action]")) {
      button.onclick = () => {
        if (button.dataset.drawingAction === "edit") openDrawingEdit(wrapper.dataset.id);
        else void reorderDrawing(wrapper.dataset.id, button.dataset.drawingAction)
      }
    }
  }
}

function openDrawingEdit(drawingId) {
  editingDrawing = drawings.find(drawing => drawing.id === drawingId);
  if (!editingDrawing) return;
  document.querySelector("#editingDrawingOriginalName").textContent = editingDrawing.originalName;
  editingDrawingDisplayName.value = editingDrawing.displayName;
  editingDrawingDescription.value = editingDrawing.description || "";
  drawingEditDialog.showModal();
  editingDrawingDisplayName.focus();
  editingDrawingDisplayName.select()
}

async function saveDrawingInformation() {
  const displayName = editingDrawingDisplayName.value.trim();
  if (!editingDrawing || !displayName) return;
  editingDrawing.displayName = displayName;
  editingDrawing.description = editingDrawingDescription.value.trim();
  await saveDrawing(editingDrawing);
  drawingEditDialog.close();
  renderDrawingList();
  if (activeDrawing?.id === editingDrawing.id) {
    document.querySelector("#activeDrawingName").textContent = editingDrawing.displayName;
    document.querySelector("#activeDrawingDescription").textContent = `${editingDrawing.originalName} · ${formatBytes(editingDrawing.file.size)} · ${editingDrawing.codepage || "코드페이지 미확인"}${editingDrawing.description ? ` · ${editingDrawing.description}` : ""}`;
    renderEquipmentList()
  }
}

async function reorderDrawing(drawingId, direction) {
  const activeId = activeDrawing?.id;
  drawings = moveDrawing(drawings, drawingId, direction);
  activeDrawing = drawings.find(drawing => drawing.id === activeId);
  // 모든 도면의 연속 sortOrder를 순차 commit해 일부 값만 저장된 중간 상태를 최소화한다.
  for (const drawing of drawings) await saveDrawing(drawing);
  renderDrawingList()
}

function renderEquipmentReport() {
  const report = buildEquipmentReport(drawings);
  document.querySelector("#equipmentReportSummary").textContent = `등록 도면 ${drawings.length.toLocaleString("ko-KR")}개 · 장비 ${report.details.length.toLocaleString("ko-KR")}개`;
  document.querySelector("#equipmentTotalBubbles").innerHTML = report.totals.length
    ? report.totals.map(item => `<span>${escapeHtml(item.category)} ${item.count.toLocaleString("ko-KR")}</span>`).join("")
    : '<div class="empty-row">집계할 장비가 없습니다.</div>';
  document.querySelector("#equipmentReportRows").innerHTML = report.byDrawing.length
    ? report.byDrawing.map(item => `<tr><td>${escapeHtml(item.drawingName)}</td><td>${escapeHtml(item.category)}</td><td>${item.count.toLocaleString("ko-KR")}</td></tr>`).join("")
    : '<tr><td colspan="3">집계할 장비가 없습니다.</td></tr>'
}

function openEquipmentReport() {
  renderEquipmentReport();
  document.querySelector("#equipmentReportDialog").showModal()
}

function exportEquipmentWorkbook() {
  const report = buildEquipmentReport(drawings);
  if (!report.details.length) {
    alert("내보낼 장비가 없습니다.");
    return
  }
  const workbook = createEquipmentWorkbook(report);
  const url = URL.createObjectURL(new Blob([workbook], {type: "application/vnd.ms-excel;charset=utf-8"}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `층별-장비-목록-${new Date().toISOString().slice(0, 10)}.xls`;
  anchor.click();
  URL.revokeObjectURL(url)
}

async function importEquipmentWorkbook(file) {
  try {
    // Excel에서 수정 가능한 값은 판넬명과 검수 상태뿐이다. 숨김 식별 키가 일치하는 행만
    // correction으로 저장해 정렬 변경이나 같은 이름의 다른 장비에 값이 섞이지 않게 한다.
    const rows = parseEquipmentWorkbook(await file.text());
    if (!confirm(`Excel 장비목록 ${rows.length.toLocaleString("ko-KR")}개 행에서 판넬명과 검수 상태를 가져올까요?`)) return;
    const result = applyEquipmentWorkbookRows(drawings, rows);
    if (!result.matched) throw new Error("현재 등록 도면과 일치하는 장비가 없습니다.");
    for (const drawing of drawings) {
      if (!result.changedDrawingIds.has(drawing.id)) continue;
      applyDrawingCorrections(drawing);
      await saveDrawing(drawing)
    }
    renderDrawingList();
    renderEquipmentList();
    alert(`Excel 가져오기 완료\n일치 ${result.matched.toLocaleString("ko-KR")}개 · 변경 ${result.updated.toLocaleString("ko-KR")}개 · 불일치 ${result.unmatched.toLocaleString("ko-KR")}개`)
  } catch (error) {
    alert(`Excel 가져오기 실패: ${error.message}\n이 애플리케이션에서 내보낸 장비목록 .xls 파일인지 확인하세요.`)
  }
}

function renderEquipmentList() {
  if (!activeDrawing) {
    visibleEquipmentRows = [];
    selectedEquipmentKeys.clear();
    document.querySelector("#equipmentFilters").innerHTML = "";
    document.querySelector("#equipmentList").innerHTML = '<div class="empty-row">선택된 도면이 없습니다.</div>';
    updateBulkActions();
    return
  }
  const query = searchInput.value.trim().toLocaleUpperCase("ko-KR");
  const allEquipment = activeDrawing.equipment.filter(item => item.priority < Number.MAX_SAFE_INTEGER);
  const documentedEquipment = allEquipment.filter(item => !item.userExcluded);
  const excludedEquipment = allEquipment.filter(item => item.userExcluded);
  const duplicateCounts = new Map();
  for (const item of documentedEquipment) {
    const key = equipmentDuplicateKey(item);
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1)
  }
  for (const item of allEquipment) item.duplicateSuspected = !item.userExcluded && (duplicateCounts.get(equipmentDuplicateKey(item)) || 0) > 1;
  // 확인 완료된 장비는 문제를 검토한 것으로 보고 문제 필터에서 숨긴다.
  // 검수 상태를 미검토 또는 수정 필요로 되돌리면 동일 판정 규칙에 따라 다시 노출된다.
  const pendingIssueEquipment = documentedEquipment.filter(isPendingEquipmentIssue);
  const unmatchedEquipment = pendingIssueEquipment.filter(item => !item.panelName);
  const lowConfidenceEquipment = pendingIssueEquipment.filter(item => item.panelMatchConfidence === "low");
  const duplicateEquipment = pendingIssueEquipment.filter(item => item.duplicateSuspected);
  const unreviewedEquipment = documentedEquipment.filter(item => item.reviewStatus !== "reviewed" && item.reviewStatus !== "needs_revision");
  const reviewedEquipment = documentedEquipment.filter(item => item.reviewStatus === "reviewed");
  const needsRevisionEquipment = documentedEquipment.filter(item => item.reviewStatus === "needs_revision");
  // 고정 필터가 아니라 현재 도면에서 실제 검출된 분류만 버블 버튼으로 만든다.
  const categoryCounts = new Map();
  for (const item of documentedEquipment) categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
  const specialFilters = new Set(["__unmatched__", "__low_confidence__", "__duplicates__", "__excluded__", "__unreviewed__", "__reviewed__", "__needs_revision__"]);
  if (selectedEquipmentCategory && !specialFilters.has(selectedEquipmentCategory) && !categoryCounts.has(selectedEquipmentCategory)) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__excluded__" && !excludedEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__unmatched__" && !unmatchedEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__low_confidence__" && !lowConfidenceEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__duplicates__" && !duplicateEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__unreviewed__" && !unreviewedEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__reviewed__" && !reviewedEquipment.length) selectedEquipmentCategory = "";
  if (selectedEquipmentCategory === "__needs_revision__" && !needsRevisionEquipment.length) selectedEquipmentCategory = "";
  const categories = [...categoryCounts].sort((a, b) => {
    const firstPriority = documentedEquipment.find(item => item.category === a[0])?.priority ?? Number.MAX_SAFE_INTEGER;
    const secondPriority = documentedEquipment.find(item => item.category === b[0])?.priority ?? Number.MAX_SAFE_INTEGER;
    return firstPriority - secondPriority || a[0].localeCompare(b[0], "ko")
  });
  document.querySelector("#equipmentFilters").innerHTML = `
    <button class="equipment-filter ${selectedEquipmentCategory ? "" : "active"}" data-category="">전체 <span>${documentedEquipment.length.toLocaleString("ko-KR")}</span></button>
    ${categories.map(([category, count]) => `<button class="equipment-filter ${selectedEquipmentCategory === category ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)} <span>${count.toLocaleString("ko-KR")}</span></button>`).join("")}
    ${unmatchedEquipment.length ? `<button class="equipment-filter warning ${selectedEquipmentCategory === "__unmatched__" ? "active" : ""}" data-category="__unmatched__">미연결 <span>${unmatchedEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${lowConfidenceEquipment.length ? `<button class="equipment-filter warning ${selectedEquipmentCategory === "__low_confidence__" ? "active" : ""}" data-category="__low_confidence__">저신뢰 <span>${lowConfidenceEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${duplicateEquipment.length ? `<button class="equipment-filter warning ${selectedEquipmentCategory === "__duplicates__" ? "active" : ""}" data-category="__duplicates__">중복 의심 <span>${duplicateEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${unreviewedEquipment.length ? `<button class="equipment-filter ${selectedEquipmentCategory === "__unreviewed__" ? "active" : ""}" data-category="__unreviewed__">미검토 <span>${unreviewedEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${reviewedEquipment.length ? `<button class="equipment-filter ${selectedEquipmentCategory === "__reviewed__" ? "active" : ""}" data-category="__reviewed__">확인 완료 <span>${reviewedEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${needsRevisionEquipment.length ? `<button class="equipment-filter warning ${selectedEquipmentCategory === "__needs_revision__" ? "active" : ""}" data-category="__needs_revision__">수정 필요 <span>${needsRevisionEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
    ${excludedEquipment.length ? `<button class="equipment-filter excluded ${selectedEquipmentCategory === "__excluded__" ? "active" : ""}" data-category="__excluded__">제외됨 <span>${excludedEquipment.length.toLocaleString("ko-KR")}</span></button>` : ""}
  `;
  const listSource = selectedEquipmentCategory === "__excluded__"
    ? excludedEquipment
    : selectedEquipmentCategory === "__unmatched__"
      ? unmatchedEquipment
      : selectedEquipmentCategory === "__low_confidence__"
        ? lowConfidenceEquipment
        : selectedEquipmentCategory === "__duplicates__"
          ? duplicateEquipment
          : selectedEquipmentCategory === "__unreviewed__"
            ? unreviewedEquipment
            : selectedEquipmentCategory === "__reviewed__"
              ? reviewedEquipment
              : selectedEquipmentCategory === "__needs_revision__"
                ? needsRevisionEquipment
          : documentedEquipment;
  const rows = listSource.filter(item => {
    const categoryMatched = !selectedEquipmentCategory || specialFilters.has(selectedEquipmentCategory) || item.category === selectedEquipmentCategory;
    const queryMatched = !query || `${item.name} ${item.category}`.toLocaleUpperCase("ko-KR").includes(query);
    return categoryMatched && queryMatched
  });
  const filtered = selectedEquipmentCategory || query;
  visibleEquipmentRows = rows;
  const correctedCount = allEquipment.filter(item => item.userCorrected).length;
  document.querySelector("#equipmentSummary").textContent = `${activeDrawing.displayName} · 확정 장비 ${documentedEquipment.length.toLocaleString("ko-KR")}개 · 미연결 ${unmatchedEquipment.length.toLocaleString("ko-KR")}개 · 저신뢰 ${lowConfidenceEquipment.length.toLocaleString("ko-KR")}개 · 중복 의심 ${duplicateEquipment.length.toLocaleString("ko-KR")}개 · 확인 완료 ${reviewedEquipment.length.toLocaleString("ko-KR")}개 · 사용자 교정 ${correctedCount.toLocaleString("ko-KR")}개${excludedEquipment.length ? ` · 제외 ${excludedEquipment.length.toLocaleString("ko-KR")}개` : ""}${filtered ? ` · 필터 결과 ${rows.length.toLocaleString("ko-KR")}개` : ""}`;
  document.querySelector("#equipmentList").innerHTML = rows.length ? rows.slice(0, 5000).map((item, index) => `
    <div class="equipment-row ${item.userExcluded ? "is-excluded" : ""} ${item.duplicateSuspected ? "is-duplicate" : ""}" data-index="${activeDrawing.equipment.indexOf(item)}">
      <label class="equipment-select" title="장비 선택"><input type="checkbox" ${selectedEquipmentKeys.has(equipmentCorrectionKey(item)) ? "checked" : ""}></label>
      <button type="button" class="equipment-focus">
        <span class="equipment-number">${index + 1}</span>
        <strong>${escapeHtml(item.name)}${item.userCorrected ? "<i>사용자 교정</i>" : ""}${item.duplicateSuspected ? "<i class=\"duplicate-badge\">중복 의심</i>" : ""}${item.reviewStatus === "reviewed" ? "<i class=\"reviewed-badge\">확인 완료</i>" : ""}${item.reviewStatus === "needs_revision" ? "<i class=\"revision-badge\">수정 필요</i>" : ""}${Number.isFinite(item.priority) && item.priority < Number.MAX_SAFE_INTEGER ? `<em>${escapeHtml(item.category)}</em>` : ""}</strong>
        <span>X ${item.x.toFixed(2)} · Y ${item.y.toFixed(2)} · ${escapeHtml(confidenceLabel(item))} · ${escapeHtml(reviewStatusLabel(item))}${Number.isFinite(item.panelMatchDistance) ? ` · 거리 ${item.panelMatchDistance.toFixed(1)}` : ""}</span>
      </button>
      <button type="button" class="equipment-edit">수정</button>
    </div>
  `).join("") : '<div class="empty-row">해당 장비명이 없습니다.</div>';
  for (const row of document.querySelectorAll(".equipment-row")) {
    const equipment = activeDrawing.equipment[Number(row.dataset.index)];
    row.querySelector(".equipment-focus").onclick = () => focusEquipment(equipment, row);
    row.querySelector(".equipment-edit").onclick = () => openEquipmentCorrection(equipment)
    const checkbox = row.querySelector(".equipment-select input");
    checkbox.onchange = () => {
      const key = equipmentCorrectionKey(equipment);
      if (checkbox.checked) selectedEquipmentKeys.add(key);
      else selectedEquipmentKeys.delete(key);
      updateBulkActions()
    }
  }
  for (const filter of document.querySelectorAll(".equipment-filter")) {
    filter.onclick = () => {
      selectedEquipmentCategory = filter.dataset.category || "";
      selectedEquipmentKeys.clear();
      renderEquipmentList()
    }
  }
  updateBulkActions()
}

function openEquipmentCorrection(equipment) {
  correctingEquipment = equipment;
  document.querySelector("#correctionSourceText").textContent = `${equipment.category} · ${equipment.sourceName}`;
  document.querySelector("#automaticPanelName").value = equipment.autoPanelName || "연결 없음";
  correctedPanelInput.value = equipment.panelName || "";
  excludeEquipmentInput.checked = Boolean(equipment.userExcluded);
  reviewStatusInput.value = equipment.reviewStatus || "unreviewed";
  correctionDialog.showModal();
  correctedPanelInput.focus()
}

async function saveEquipmentCorrection() {
  if (!activeDrawing || !correctingEquipment) return;
  try {
    const key = equipmentCorrectionKey(correctingEquipment);
    activeDrawing.equipmentCorrections ||= {};
    activeDrawing.equipmentCorrections[key] = {
      ...(activeDrawing.equipmentCorrections[key] || {}),
      panelName: correctedPanelInput.value.trim().replace(/\s*[-_/]\s*/g, "-"),
      excluded: excludeEquipmentInput.checked,
      reviewStatus: reviewStatusInput.value,
      updatedAt: new Date().toISOString()
    };
    applyDrawingCorrections(activeDrawing);
    await saveDrawing(activeDrawing);
    correctionDialog.close();
    renderDrawingList();
    renderEquipmentList()
  } catch (error) {
    document.querySelector("#equipmentSummary").textContent = `장비 교정 저장 실패: ${error.message}`
  }
}

async function resetEquipmentCorrection() {
  if (!activeDrawing || !correctingEquipment) return;
  try {
    const key = equipmentCorrectionKey(correctingEquipment);
    const reviewStatus = activeDrawing.equipmentCorrections?.[key]?.reviewStatus;
    if (reviewStatus && reviewStatus !== "unreviewed") {
      activeDrawing.equipmentCorrections[key] = {reviewStatus, updatedAt: new Date().toISOString()}
    } else {
      delete activeDrawing.equipmentCorrections?.[key]
    }
    applyDrawingCorrections(activeDrawing);
    await saveDrawing(activeDrawing);
    correctionDialog.close();
    renderDrawingList();
    renderEquipmentList()
  } catch (error) {
    document.querySelector("#equipmentSummary").textContent = `자동 결과 복원 실패: ${error.message}`
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
  selectedEquipmentKeys.clear();
  document.querySelector("#activeDrawingName").textContent = activeDrawing.displayName;
  document.querySelector("#activeDrawingDescription").textContent = `${activeDrawing.originalName} · ${formatBytes(activeDrawing.file.size)} · ${activeDrawing.codepage || "코드페이지 미확인"}${activeDrawing.description ? ` · ${activeDrawing.description}` : ""}`;
  deleteButton.disabled = false;
  reanalyzeButton.disabled = false;
  searchInput.disabled = false;
  searchInput.value = "";
  renderDrawingList();
  renderEquipmentList();
  await renderActiveDrawing();
  if (activeDrawing.analysisVersion !== ANALYSIS_VERSION
    || activeDrawing.equipmentDictionaryRevision !== equipmentDictionaryRevision()) void reanalyzeActiveDrawing(true)
}

async function analyzeAndSaveDrawing(drawing) {
  const analysis = await analyzeDxf(drawing.file);
  drawing.equipment = analysis.equipment;
  drawing.codepage = analysis.codepage;
  drawing.analysisVersion = ANALYSIS_VERSION;
  drawing.equipmentDictionaryRevision = equipmentDictionaryRevision();
  applyDrawingCorrections(drawing);
  await saveDrawing(drawing);
  return drawing
}

async function reanalyzeActiveDrawing(automatic = false) {
  if (!activeDrawing || reanalyzeButton.disabled) return;
  reanalyzeButton.disabled = true;
  document.querySelector("#equipmentSummary").textContent = automatic ? "기존 장비 목록을 문서 기준으로 자동 정리하고 있습니다…" : "한글 코드페이지와 문서 우선순위 기준으로 장비를 다시 분석하고 있습니다…";
  try {
    await analyzeAndSaveDrawing(activeDrawing);
    renderDrawingList();
    renderEquipmentList()
  } catch (error) {
    document.querySelector("#equipmentSummary").textContent = `장비 재분석 실패: ${error.message}`
  } finally {
    reanalyzeButton.disabled = false
  }
}

function appendBatchAnalysisResult(drawing, kind, message) {
  const results = document.querySelector("#batchAnalysisResults");
  results.insertAdjacentHTML("beforeend", `<div class="batch-analysis-result ${kind}"><strong>${escapeHtml(drawing.displayName)}</strong><span>${escapeHtml(message)}</span></div>`);
  results.scrollTop = results.scrollHeight
}

async function reanalyzeAllDrawings() {
  if (!drawings.length || batchAnalysisRunning) return;
  batchAnalysisRunning = true;
  batchAnalysisCancelled = false;
  reanalyzeAllButton.disabled = true;
  reanalyzeButton.disabled = true;
  const dialog = document.querySelector("#batchAnalysisDialog");
  const summary = document.querySelector("#batchAnalysisSummary");
  const progress = document.querySelector("#batchAnalysisProgress");
  const cancelButton = document.querySelector("#cancelBatchAnalysisBtn");
  const finishButton = document.querySelector("#finishBatchAnalysisBtn");
  const closeButton = document.querySelector("#closeBatchAnalysisBtn");
  progress.max = drawings.length;
  progress.value = 0;
  document.querySelector("#batchAnalysisResults").innerHTML = "";
  cancelButton.disabled = false;
  cancelButton.textContent = "분석 중단";
  finishButton.disabled = true;
  closeButton.disabled = true;
  dialog.showModal();
  let succeeded = 0;
  let failed = 0;

  // 대용량 Worker를 동시에 여러 개 띄우지 않고 도면별 분석과 IndexedDB commit을 순차 실행한다.
  // 한 도면이 실패해도 다음 도면을 계속 처리하며 중단 요청은 현재 commit 이후 확인한다.
  for (let index = 0; index < drawings.length; index++) {
    if (batchAnalysisCancelled) break;
    const drawing = drawings[index];
    summary.textContent = `${index + 1}/${drawings.length} · ${drawing.displayName} 분석 중…`;
    try {
      await analyzeAndSaveDrawing(drawing);
      succeeded++;
      appendBatchAnalysisResult(drawing, "success", `완료 · 장비 ${drawing.equipment.length.toLocaleString("ko-KR")}개`)
    } catch (error) {
      failed++;
      appendBatchAnalysisResult(drawing, "error", `실패 · ${error.message}`)
    }
    progress.value = index + 1
  }

  batchAnalysisRunning = false;
  const stopped = batchAnalysisCancelled;
  summary.textContent = `${stopped ? "중단됨" : "완료"} · 성공 ${succeeded.toLocaleString("ko-KR")}개 · 실패 ${failed.toLocaleString("ko-KR")}개${stopped ? ` · 미처리 ${(drawings.length - progress.value).toLocaleString("ko-KR")}개` : ""}`;
  cancelButton.disabled = true;
  finishButton.disabled = false;
  closeButton.disabled = false;
  reanalyzeButton.disabled = !activeDrawing;
  renderDrawingList();
  renderEquipmentList()
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
      equipmentCorrections: {},
      codepage: analysis.codepage,
      analysisVersion: ANALYSIS_VERSION,
      equipmentDictionaryRevision: equipmentDictionaryRevision(),
      sortOrder: drawings.length ? Math.min(...drawings.map(item => Number.isFinite(item.sortOrder) ? item.sortOrder : 0)) - 1 : 0,
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
searchInput.oninput = () => {
  selectedEquipmentKeys.clear();
  renderEquipmentList()
};
correctionForm.onsubmit = event => {
  event.preventDefault();
  void saveEquipmentCorrection()
};
document.querySelector("#resetCorrectionBtn").onclick = () => void resetEquipmentCorrection();
document.querySelector("#cancelCorrectionBtn").onclick = () => correctionDialog.close();
document.querySelector("#closeCorrectionBtn").onclick = () => correctionDialog.close();
drawingEditForm.onsubmit = event => {
  event.preventDefault();
  void saveDrawingInformation()
};
document.querySelector("#cancelDrawingEditBtn").onclick = () => drawingEditDialog.close();
document.querySelector("#closeDrawingEditBtn").onclick = () => drawingEditDialog.close();
document.querySelector("#toggleDrawingEditModeBtn").onclick = () => {
  drawingListEditMode = !drawingListEditMode;
  renderDrawingList()
};
document.querySelector("#manageEquipmentDictionaryBtn").onclick = openEquipmentDictionary;
document.querySelector("#equipmentSummaryBtn").onclick = openEquipmentReport;
document.querySelector("#exportEquipmentBtn").onclick = exportEquipmentWorkbook;
document.querySelector("#importEquipmentFile").onchange = event => {
  const file = event.target.files?.[0];
  if (file) void importEquipmentWorkbook(file);
  event.target.value = ""
};
document.querySelector("#reportExportEquipmentBtn").onclick = exportEquipmentWorkbook;
document.querySelector("#cancelEquipmentReportBtn").onclick = () => document.querySelector("#equipmentReportDialog").close();
document.querySelector("#closeEquipmentReportBtn").onclick = () => document.querySelector("#equipmentReportDialog").close();
document.querySelector("#selectVisibleEquipmentBtn").onclick = () => {
  const keys = visibleEquipmentRows.map(equipmentCorrectionKey);
  const allSelected = keys.length && keys.every(key => selectedEquipmentKeys.has(key));
  for (const key of keys) {
    if (allSelected) selectedEquipmentKeys.delete(key);
    else selectedEquipmentKeys.add(key)
  }
  renderEquipmentList()
};
document.querySelector("#clearEquipmentSelectionBtn").onclick = () => {
  selectedEquipmentKeys.clear();
  renderEquipmentList()
};
document.querySelector("#excludeSelectedEquipmentBtn").onclick = () => {
  const restoring = selectedEquipmentCategory === "__excluded__";
  void updateSelectedEquipmentCorrections(
    {excluded: !restoring},
    restoring
      ? `선택한 장비 ${selectedEquipmentKeys.size.toLocaleString("ko-KR")}개를 목록에 복원할까요?`
      : `선택한 장비 ${selectedEquipmentKeys.size.toLocaleString("ko-KR")}개를 목록에서 제외할까요? 제외됨 필터에서 복원할 수 있습니다.`
  )
};
document.querySelector("#markSelectedReviewedBtn").onclick = () => void updateSelectedEquipmentCorrections({reviewStatus: "reviewed"});
document.querySelector("#markSelectedUnreviewedBtn").onclick = () => void updateSelectedEquipmentCorrections({reviewStatus: "unreviewed"});
document.querySelector("#markSelectedNeedsRevisionBtn").onclick = () => void updateSelectedEquipmentCorrections({reviewStatus: "needs_revision"});
dictionaryForm.onsubmit = event => {
  event.preventDefault();
  void saveCustomEquipmentRule()
};
document.querySelector("#cancelEquipmentDictionaryBtn").onclick = () => dictionaryDialog.close();
document.querySelector("#closeEquipmentDictionaryBtn").onclick = () => dictionaryDialog.close();
document.querySelector("#exportEquipmentDictionaryBtn").onclick = exportEquipmentDictionary;
document.querySelector("#importEquipmentDictionaryFile").onchange = event => {
  const file = event.target.files?.[0];
  if (file) void importEquipmentDictionary(file);
  event.target.value = ""
};
document.querySelector("#restoreEquipmentDictionaryBtn").onclick = () => void restoreEquipmentDictionary();
reanalyzeButton.onclick = () => reanalyzeActiveDrawing();
reanalyzeAllButton.onclick = () => void reanalyzeAllDrawings();
document.querySelector("#cancelBatchAnalysisBtn").onclick = () => {
  batchAnalysisCancelled = true;
  document.querySelector("#cancelBatchAnalysisBtn").disabled = true;
  document.querySelector("#cancelBatchAnalysisBtn").textContent = "현재 도면 완료 후 중단"
};
document.querySelector("#finishBatchAnalysisBtn").onclick = () => document.querySelector("#batchAnalysisDialog").close();
document.querySelector("#closeBatchAnalysisBtn").onclick = () => document.querySelector("#batchAnalysisDialog").close();
document.querySelector("#batchAnalysisDialog").addEventListener("cancel", event => {
  if (batchAnalysisRunning) event.preventDefault()
});
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
    const storedDrawings = await getDrawings();
    const orderMigrationRequired = storedDrawings.some(drawing => !Number.isFinite(drawing.sortOrder));
    drawings = normalizeDrawingOrder(storedDrawings);
    // 기존 IndexedDB 데이터에 순서가 없으면 현재 최신 등록순을 최초 순서로 한 번 저장한다.
    if (orderMigrationRequired) {
      for (const drawing of drawings) await saveDrawing(drawing)
    }
    for (const drawing of drawings) {
      // 현재 버전 결과는 저장된 판넬명을 그대로 복원한다. 여기서 다시 표준 장비명으로
      // 계산하면 `UPS · 5F-1D-3`의 판넬 부분이 새로고침 때 사라지게 된다.
      if (drawing.analysisVersion === ANALYSIS_VERSION) {
        drawing.equipment = (drawing.equipment || []).filter(item => item.priority < Number.MAX_SAFE_INTEGER);
        applyDrawingCorrections(drawing);
        continue
      }
      drawing.equipment = (drawing.equipment || []).map(item => {
        const sourceName = cleanCadText(item.sourceName || item.name || ""), classification = equipmentPriority(sourceName);
        const baseName = classification.priority < Number.MAX_SAFE_INTEGER ? equipmentLabel(sourceName, classification) : "";
        return {...item, sourceName, name: item.panelName ? `${baseName} · ${item.panelName}` : baseName, ...classification}
      }).filter(item => item.priority < Number.MAX_SAFE_INTEGER)
        .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}));
      applyDrawingCorrections(drawing)
    }
    renderDrawingList();
    if (drawings[0]) await selectDrawing(drawings[0].id)
  } catch (error) {
    document.querySelector("#registerStatus").textContent = `브라우저 저장소를 열지 못했습니다: ${error.message}`
  }
}

void initialize();
