import {equipmentCorrectionKey} from "./corrections.js";

function includedEquipment(drawing) {
  return (drawing.equipment || []).filter(item => Number.isFinite(item.priority)
    && item.priority < Number.MAX_SAFE_INTEGER
    && !item.userExcluded)
}

const confidenceLabels = {
  high: "높은 신뢰",
  medium: "보통 신뢰",
  low: "저신뢰",
  manual: "수동 확정",
  unmatched: "미연결",
  unknown: "신뢰도 미산정"
};

/** 등록된 모든 도면에서 장비 상세 행과 도면별·전체 분류 수량을 만든다. */
export function buildEquipmentReport(drawings) {
  const details = [];
  const drawingCounts = new Map();
  const totalCounts = new Map();

  for (const drawing of drawings || []) {
    for (const item of includedEquipment(drawing)) {
      details.push({
        drawingId: drawing.id || "",
        equipmentKey: equipmentCorrectionKey(item),
        drawingName: drawing.displayName || "",
        originalName: drawing.originalName || "",
        description: drawing.description || "",
        category: item.category || "",
        equipmentName: item.name || "",
        sourceName: item.sourceName || "",
        panelName: item.panelName || "",
        x: Number(item.x || 0),
        y: Number(item.y || 0),
        confidence: confidenceLabels[item.panelMatchConfidence]
          || confidenceLabels[item.panelName ? "unknown" : "unmatched"],
        matchDistance: Number.isFinite(item.panelMatchDistance) ? item.panelMatchDistance : "",
        userCorrected: item.userCorrected ? "예" : "아니오",
        reviewStatus: ({reviewed: "확인 완료", needs_revision: "수정 필요"})[item.reviewStatus] || "미검토"
      });
      const drawingKey = `${drawing.id || drawing.displayName}\u0000${item.category}`;
      const previous = drawingCounts.get(drawingKey) || {
        drawingName: drawing.displayName || "",
        category: item.category || "",
        count: 0
      };
      previous.count++;
      drawingCounts.set(drawingKey, previous);
      totalCounts.set(item.category, (totalCounts.get(item.category) || 0) + 1)
    }
  }

  return {
    details,
    byDrawing: [...drawingCounts.values()],
    totals: [...totalCounts].map(([category, count]) => ({category, count}))
  }
}

const xmlEscape = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[character]);

function worksheet(name, headers, rows, hiddenColumns = 0) {
  const rowXml = [headers, ...rows].map((row, rowIndex) => `<Row>${row.map(value => {
    const numeric = typeof value === "number" && Number.isFinite(value);
    const style = rowIndex === 0 ? ' ss:StyleID="Header"' : "";
    return `<Cell${style}><Data ss:Type="${numeric ? "Number" : "String"}">${xmlEscape(value)}</Data></Cell>`
  }).join("")}</Row>`).join("");
  const columns = Array.from({length: hiddenColumns}, () => '<Column ss:Hidden="1"/>').join("");
  return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${columns}${rowXml}</Table></Worksheet>`
}

/** Excel 2003 이상에서 열 수 있는 두 시트 SpreadsheetML 문서를 생성한다. */
export function createEquipmentWorkbook(report) {
  const detailHeaders = ["도면 ID", "장비 키", "도면명", "원본 파일명", "도면 설명", "분류", "장비명", "원본 문자", "판넬명", "X", "Y", "매칭 신뢰도", "매칭 거리", "사용자 교정", "검수 상태"];
  const detailRows = report.details.map(item => [
    item.drawingId, item.equipmentKey, item.drawingName, item.originalName, item.description, item.category, item.equipmentName,
    item.sourceName, item.panelName, item.x, item.y, item.confidence, item.matchDistance, item.userCorrected, item.reviewStatus
  ]);
  const summaryRows = [
    ...report.totals.map(item => ["전체", item.category, item.count]),
    ...report.byDrawing.map(item => [item.drawingName, item.category, item.count])
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/></Style></Styles>
${worksheet("장비목록", detailHeaders, detailRows, 2)}
${worksheet("수량집계", ["범위", "장비 분류", "수량"], summaryRows)}
</Workbook>`
}

const xmlUnescape = value => String(value || "")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");

/** 이 애플리케이션에서 내보낸 SpreadsheetML 장비목록 시트를 구조화된 행으로 읽는다. */
export function parseEquipmentWorkbook(source) {
  const worksheet = String(source).match(/<Worksheet\b[^>]*ss:Name="장비목록"[^>]*>([\s\S]*?)<\/Worksheet>/i)?.[1];
  if (!worksheet) throw new Error("장비목록 워크시트를 찾을 수 없습니다.");
  const rows = [...worksheet.matchAll(/<Row\b[^>]*>([\s\S]*?)<\/Row>/gi)].map(match =>
    [...match[1].matchAll(/<Data\b[^>]*>([\s\S]*?)<\/Data>/gi)].map(cell => xmlUnescape(cell[1]))
  );
  if (rows.length < 2) throw new Error("가져올 장비 행이 없습니다.");
  const headers = rows[0];
  for (const required of ["도면 ID", "장비 키", "판넬명", "검수 상태"]) {
    if (!headers.includes(required)) throw new Error(`필수 열이 없습니다: ${required}`)
  }
  return rows.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])))
}

/** 가져온 판넬명과 검수 상태를 일치하는 장비 correction에 병합한다. */
export function applyEquipmentWorkbookRows(drawings, rows, updatedAt = new Date().toISOString()) {
  const changedDrawingIds = new Set();
  let matched = 0;
  let updated = 0;
  for (const row of rows || []) {
    const drawing = (drawings || []).find(item => item.id === row["도면 ID"]);
    if (!drawing) continue;
    const item = (drawing.equipment || []).find(equipment => equipmentCorrectionKey(equipment) === row["장비 키"]);
    if (!item) continue;
    matched++;
    const reviewStatus = ({"확인 완료": "reviewed", "수정 필요": "needs_revision", "미검토": "unreviewed"})[row["검수 상태"]] || "unreviewed";
    const panelName = String(row["판넬명"] || "").trim().replace(/\s*[-_/]\s*/g, "-");
    const existing = drawing.equipmentCorrections?.[row["장비 키"]] || {};
    const panelChanged = panelName !== String(item.panelName || "");
    const reviewChanged = reviewStatus !== (item.reviewStatus || "unreviewed");
    if (!panelChanged && !reviewChanged) continue;
    drawing.equipmentCorrections ||= {};
    drawing.equipmentCorrections[row["장비 키"]] = {
      ...existing,
      ...(panelChanged ? {panelName} : {}),
      reviewStatus,
      updatedAt
    };
    changedDrawingIds.add(drawing.id);
    updated++
  }
  return {matched, updated, unmatched: (rows || []).length - matched, changedDrawingIds}
}
