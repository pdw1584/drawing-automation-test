import test from "node:test";
import assert from "node:assert/strict";
import {configureEquipmentPriorities, equipmentCandidates} from "../../src/features/equipment/analysis.js";
import {applyEquipmentCorrections, equipmentCorrectionKey} from "../../src/features/equipment/corrections.js";

configureEquipmentPriorities([
  {name: "UPS", aliases: ["UPS"]},
  {name: "STS", aliases: ["STS"]},
  {name: "CTTS", aliases: ["CTTS", "CLOSED TRANSITION TRANSFER SWITCH"]},
  {name: "Battery", aliases: ["BAT", "BATTERY"]},
  {name: "MHV", aliases: ["MHV"]},
  {name: "HV", aliases: ["HV"]},
  {name: "RF", aliases: ["RF"]},
  {name: "MTR", aliases: ["MTR"]},
  {name: "LV", aliases: ["LV"]},
  {name: "TR", aliases: ["TR"]},
  {name: "SC", aliases: ["SC"]},
  {name: "ODU", aliases: ["ODU"]},
  {name: "FC", aliases: ["FC", "FREE COOLING"]},
  {name: "버퍼탱크", aliases: ["BT", "BUFFER TANK", "버퍼탱크"]},
  {name: "T/L PRO", aliases: ["T/L PRO", "TL PRO"]},
  {name: "BUS PRO", aliases: ["BUS PRO"]},
  {name: "BUS TIE", aliases: ["BUS TIE"]},
  {name: "AC & B/C", aliases: ["AC & B/C"]},
  {name: "BATT & DC", aliases: ["BATT & DC"]},
  {name: "MOF", aliases: ["MOF"]},
  {name: "RTU", aliases: ["RTU"]}
]);

test("UPS에 가장 가까운 층 판넬명을 연결한다", () => {
  const items = [
    {text: "UPS", x: 100, y: 100, w: 20, h: 10},
    {text: "5F-1D-3", x: 112, y: 100, w: 40, h: 10}
  ];
  assert.equal(equipmentCandidates(items)[0].name, "UPS · 5F-1D-3")
});

test("CTTS에 가장 가까운 판넬명을 연결한다", () => {
  const items = [
    {text: "CTTS", x: 100, y: 100, w: 20, h: 10},
    {text: "6F-1A-1", x: 112, y: 100, w: 40, h: 10}
  ];
  const equipment = equipmentCandidates(items)[0];
  assert.equal(equipment.category, "CTTS");
  assert.equal(equipment.name, "CTTS · 6F-1A-1");
  assert.equal(equipment.panelName, "6F-1A-1");
});

test("HV는 여러 단축 판넬 중 가장 가까운 2B-PT를 연결한다", () => {
  const items = [
    {text: "HV", x: 100, y: 100, w: 20, h: 10},
    {text: "2B-PT", x: 105, y: 100, w: 35, h: 10},
    {text: "2A-1", x: 140, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items)[0];
  assert.equal(equipment.category, "HV");
  assert.equal(equipment.name, "HV · 2B-PT");
  assert.equal(equipment.panelName, "2B-PT");
});

test("HV에 영문 구역과 번호로 구성된 BU-1-PT 판넬명을 연결한다", () => {
  const items = [
    {text: "HV", x: 100, y: 100, w: 20, h: 10},
    {text: "BU_1_PT", x: 112, y: 100, w: 40, h: 10}
  ];
  const equipment = equipmentCandidates(items)[0];
  assert.equal(equipment.name, "HV · BU-1-PT");
  assert.equal(equipment.panelName, "BU-1-PT");
});

test("LV, HV, SC에 공통 단축 판넬명을 연결한다", () => {
  const items = [
    {text: "LV", x: 100, y: 100, w: 20, h: 10},
    {text: "OM-1", x: 110, y: 100, w: 30, h: 10},
    {text: "HV", x: 300, y: 100, w: 20, h: 10},
    {text: "1BB", x: 310, y: 100, w: 25, h: 10},
    {text: "SC", x: 500, y: 100, w: 20, h: 10},
    {text: "OF_1", x: 510, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "LV · OM-1"));
  assert.ok(equipment.some(item => item.name === "HV · 1BB"));
  assert.ok(equipment.some(item => item.name === "SC · OF-1"));
});

test("1A-PT, 1A-1, 1A-2를 서로 다른 인접 판넬로 연결한다", () => {
  const items = [
    {text: "HV", x: 100, y: 100, w: 20, h: 10},
    {text: "1A-PT", x: 108, y: 100, w: 30, h: 10},
    {text: "LV", x: 300, y: 100, w: 20, h: 10},
    {text: "1A-1", x: 308, y: 100, w: 30, h: 10},
    {text: "SC", x: 500, y: 100, w: 20, h: 10},
    {text: "1A-2", x: 508, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "HV · 1A-PT"));
  assert.ok(equipment.some(item => item.name === "LV · 1A-1"));
  assert.ok(equipment.some(item => item.name === "SC · 1A-2"));
});

test("C1-PT와 C1-1 형식도 독립 판넬로 연결한다", () => {
  const items = [
    {text: "HV", x: 100, y: 100, w: 20, h: 10},
    {text: "C1-PT", x: 108, y: 100, w: 30, h: 10},
    {text: "SC", x: 300, y: 100, w: 20, h: 10},
    {text: "C1/1", x: 308, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "HV · C1-PT"));
  assert.ok(equipment.some(item => item.name === "SC · C1-1"));
});

test("UPS도 CR 판넬 대신 가까운 C1 단축 판넬을 연결한다", () => {
  const items = [
    {text: "UPS", x: 100, y: 100, w: 20, h: 10},
    {text: "C1-1", x: 108, y: 100, w: 30, h: 10},
    {text: "CR-1-1", x: 150, y: 100, w: 40, h: 10},
    {text: "UPS", x: 300, y: 100, w: 20, h: 10},
    {text: "C1_6", x: 308, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "UPS · C1-1"));
  assert.ok(equipment.some(item => item.name === "UPS · C1-6"));
});

test("MHV, CTTS, UPS, BAT에 3A 계열 단축 판넬을 각각 연결한다", () => {
  const items = [
    {text: "MHV", x: 100, y: 100, w: 20, h: 10},
    {text: "3A-1", x: 108, y: 100, w: 30, h: 10},
    {text: "CTTS", x: 300, y: 100, w: 20, h: 10},
    {text: "3A-PT", x: 308, y: 100, w: 30, h: 10},
    {text: "UPS", x: 500, y: 100, w: 20, h: 10},
    {text: "3A-2", x: 508, y: 100, w: 30, h: 10},
    {text: "BAT", x: 700, y: 100, w: 20, h: 10},
    {text: "3A-4", x: 708, y: 100, w: 30, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "MHV · 3A-1"));
  assert.ok(equipment.some(item => item.name === "CTTS · 3A-PT"));
  assert.ok(equipment.some(item => item.name === "UPS · 3A-2"));
  assert.ok(equipment.some(item => item.name === "Battery · 3A-4"));
});

test("MHV에 1BB와 1BA 판넬을 각각 연결한다", () => {
  const items = [
    {text: "MHV", x: 100, y: 100, w: 20, h: 10},
    {text: "1BB", x: 108, y: 100, w: 25, h: 10},
    {text: "MHV", x: 300, y: 100, w: 20, h: 10},
    {text: "1BA", x: 308, y: 100, w: 25, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "MHV · 1BB"));
  assert.ok(equipment.some(item => item.name === "MHV · 1BA"));
});

test("MHV 두 대를 1BB와 숫자+문자 단독 판넬 1C로 분리한다", () => {
  const items = [
    {text: "MHV", x: 100, y: 100, w: 20, h: 10},
    {text: "1BB", x: 108, y: 100, w: 25, h: 10},
    {text: "MHV", x: 300, y: 100, w: 20, h: 10},
    {text: "1C", x: 308, y: 100, w: 25, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "MHV · 1BB"));
  assert.ok(equipment.some(item => item.name === "MHV · 1C"));
});

test("BAT에도 1BB와 1BA 판넬을 각각 연결한다", () => {
  const items = [
    {text: "BAT", x: 100, y: 100, w: 20, h: 10},
    {text: "1BB", x: 108, y: 100, w: 25, h: 10},
    {text: "BATTERY", x: 300, y: 100, w: 30, h: 10},
    {text: "1BA", x: 308, y: 100, w: 25, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "Battery · 1BB"));
  assert.ok(equipment.some(item => item.name === "Battery · 1BA"));
});

test("광역 매칭은 STS, TR 등 모든 판넬 연결 대상에 단축 판넬을 적용한다", () => {
  const items = [
    {text: "STS", x: 100, y: 100, w: 20, h: 10},
    {text: "OM-1", x: 108, y: 100, w: 25, h: 10},
    {text: "TR", x: 300, y: 100, w: 20, h: 10},
    {text: "C1-2", x: 308, y: 100, w: 25, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.ok(equipment.some(item => item.name === "STS · OM-1"));
  assert.ok(equipment.some(item => item.name === "TR · C1-2"));
});

test("TR은 사양 문구를 제외하고 단독명과 구조화 태그만 장비로 인정한다", () => {
  const items = [
    {text: "TR", x: 100, y: 100, w: 20, h: 10},
    {text: "A-6F-TR-01", x: 200, y: 100, w: 50, h: 10},
    {text: "TR 600KG", x: 300, y: 100, w: 50, h: 10},
    {text: "TR 6KV", x: 400, y: 100, w: 40, h: 10},
    {text: "TR 1F-CRAC-01", x: 500, y: 100, w: 70, h: 10}
  ];
  const equipment = equipmentCandidates(items);
  assert.deepEqual(equipment.map(item => item.sourceName), ["A-6F-TR-01", "TR"]);
});

test("사용자 판넬 교정과 제외 상태를 자동 분석 결과 위에 적용한다", () => {
  const item = {sourceName: "UPS", name: "UPS · CR-1-1", panelName: "CR-1-1", x: 100, y: 200};
  const key = equipmentCorrectionKey(item);
  const [corrected] = applyEquipmentCorrections([item], {
    [key]: {panelName: "C1-1", excluded: true}
  }, () => "UPS");
  assert.equal(corrected.autoPanelName, "CR-1-1");
  assert.equal(corrected.panelName, "C1-1");
  assert.equal(corrected.name, "UPS · C1-1");
  assert.equal(corrected.userExcluded, true);
  assert.equal(corrected.userCorrected, true);
  assert.equal(corrected.panelMatchConfidence, "manual");
  assert.equal(corrected.panelMatchDistance, null);
});

test("빈 판넬 교정은 자동 연결을 해제하고 교정 삭제 시 자동값을 복원한다", () => {
  const item = {sourceName: "HV", name: "HV · 1A-PT", panelName: "1A-PT", x: 10, y: 20};
  const key = equipmentCorrectionKey(item);
  const [unlinked] = applyEquipmentCorrections([item], {[key]: {panelName: "", excluded: false}}, () => "HV");
  const [restored] = applyEquipmentCorrections([item], {}, () => "HV");
  assert.equal(unlinked.name, "HV");
  assert.equal(unlinked.panelName, "");
  assert.equal(unlinked.panelMatchConfidence, "unmatched");
  assert.equal(restored.name, "HV · 1A-PT");
});

test("RF에는 짧은 구역 번호를 연결하고 UPS 판넬은 제외한다", () => {
  const items = [
    {text: "RF", x: 100, y: 100, w: 20, h: 10},
    {text: "2A-1", x: 105, y: 100, w: 30, h: 10},
    {text: "5F-1D-3", x: 101, y: 100, w: 40, h: 10}
  ];
  assert.equal(equipmentCandidates(items)[0].name, "RF · 2A-1")
});

test("추가된 전기 장비 약어를 각각 독립 분류한다", () => {
  const names = ["CTTS", "MTR", "T/L PRO", "BUS PRO", "BUS TIE", "AC & B/C", "BATT & DC", "MOF", "RTU"];
  const items = names.map((text, index) => ({text, x: index * 100, y: 0, w: 30, h: 10}));
  const categories = equipmentCandidates(items).map(item => item.category);
  assert.deepEqual(new Set(categories), new Set(names))
});

test("6층 장비에 CR 및 CRB 판넬명을 연결한다", () => {
  const items = [
    {text: "UPS", x: 100, y: 100, w: 20, h: 10},
    {text: "CRB-1A-2", x: 110, y: 100, w: 40, h: 10},
    {text: "LV", x: 300, y: 100, w: 20, h: 10},
    {text: "CR-2B-1", x: 310, y: 100, w: 40, h: 10}
  ];
  const names = equipmentCandidates(items).map(item => item.name);
  assert.ok(names.includes("UPS · CRB-1A-2"));
  assert.ok(names.includes("LV · CR-2B-1"));
});

test("6층 RF는 멀리 있는 짧은 구역명보다 인접 CR 판넬을 선택한다", () => {
  const items = [
    {text: "RF", x: 100, y: 100, w: 20, h: 10},
    {text: "CR-3C-1", x: 105, y: 100, w: 40, h: 10},
    {text: "2A-1", x: 500, y: 500, w: 20, h: 10}
  ];
  assert.equal(equipmentCandidates(items)[0].name, "RF · CR-3C-1");
});

test("ODU, FC, BT를 독립 장비로 분류하고 BT는 버퍼탱크로 표시한다", () => {
  const items = ["ODU", "FC", "BT"].map((text, index) => ({text, x: index * 100, y: 0, w: 20, h: 10}));
  const equipment = equipmentCandidates(items);
  assert.deepEqual(equipment.map(item => item.category), ["ODU", "FC", "버퍼탱크"]);
  assert.equal(equipment[2].name, "버퍼탱크");
});
