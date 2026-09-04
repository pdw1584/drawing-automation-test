import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEquipmentWorkbookRows,
  buildEquipmentReport,
  createEquipmentWorkbook,
  parseEquipmentWorkbook
} from "../../src/features/equipment/report.js";

const drawings = [
  {
    id: "floor-1",
    displayName: "1층",
    originalName: "1F.dxf",
    equipment: [
      {priority: 1, category: "UPS", name: "UPS · 1A-1", sourceName: "UPS", panelName: "1A-1", x: 10, y: 20, panelMatchConfidence: "high"},
      {priority: 2, category: "HV", name: "HV · 1B-1", sourceName: "HV", panelName: "1B-1", x: 30, y: 40, userExcluded: true}
    ]
  },
  {
    id: "floor-2",
    displayName: "2층",
    originalName: "2F.dxf",
    equipment: [
      {priority: 1, category: "UPS", name: "UPS · 2A-1", sourceName: "UPS", panelName: "2A-1", x: 50, y: 60, panelMatchConfidence: "manual", userCorrected: true}
    ]
  }
];

test("층별 장비 상세와 전체 수량을 집계하며 제외 장비는 빼준다", () => {
  const report = buildEquipmentReport(drawings);
  assert.equal(report.details.length, 2);
  assert.deepEqual(report.totals, [{category: "UPS", count: 2}]);
  assert.deepEqual(report.byDrawing, [
    {drawingName: "1층", category: "UPS", count: 1},
    {drawingName: "2층", category: "UPS", count: 1}
  ]);
  assert.equal(report.details[0].confidence, "높은 신뢰");
  assert.equal(report.details[1].confidence, "수동 확정");
});

test("장비 상세와 수량 집계를 포함한 Excel SpreadsheetML을 생성한다", () => {
  const workbook = createEquipmentWorkbook(buildEquipmentReport(drawings));
  assert.match(workbook, /Worksheet ss:Name="장비목록"/);
  assert.match(workbook, /Worksheet ss:Name="수량집계"/);
  assert.match(workbook, /UPS · 1A-1/);
  assert.match(workbook, /<Data ss:Type="Number">2<\/Data>/);
});

test("내보낸 Excel 장비목록을 읽어 판넬명과 검수 상태를 다시 적용한다", () => {
  const targetDrawings = structuredClone(drawings);
  const workbook = createEquipmentWorkbook(buildEquipmentReport(targetDrawings));
  const rows = parseEquipmentWorkbook(workbook);
  rows[0]["판넬명"] = "1A-9";
  rows[0]["검수 상태"] = "수정 필요";
  const result = applyEquipmentWorkbookRows(targetDrawings, rows, "2026-09-02T00:00:00.000Z");
  const correction = targetDrawings[0].equipmentCorrections[rows[0]["장비 키"]];
  assert.equal(result.matched, 2);
  assert.equal(result.updated, 1);
  assert.equal(correction.panelName, "1A-9");
  assert.equal(correction.reviewStatus, "needs_revision");
});

test("다른 형식의 Excel 파일은 장비목록 가져오기를 거부한다", () => {
  assert.throws(() => parseEquipmentWorkbook("not an equipment workbook"), /장비목록/);
});
