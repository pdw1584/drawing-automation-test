import test from "node:test";
import assert from "node:assert/strict";
import {configureEquipmentPriorities, equipmentCandidates} from "../../src/features/equipment/analysis.js";

configureEquipmentPriorities([
  {name: "UPS", aliases: ["UPS"]},
  {name: "HV", aliases: ["HV"]},
  {name: "RF", aliases: ["RF"]},
  {name: "MTR", aliases: ["MTR"]},
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

test("RF에는 짧은 구역 번호를 연결하고 UPS 판넬은 제외한다", () => {
  const items = [
    {text: "RF", x: 100, y: 100, w: 20, h: 10},
    {text: "2A-1", x: 105, y: 100, w: 30, h: 10},
    {text: "5F-1D-3", x: 101, y: 100, w: 40, h: 10}
  ];
  assert.equal(equipmentCandidates(items)[0].name, "RF · 2A-1")
});

test("추가된 전기 장비 약어를 각각 독립 분류한다", () => {
  const names = ["MTR", "T/L PRO", "BUS PRO", "BUS TIE", "AC & B/C", "BATT & DC", "MOF", "RTU"];
  const items = names.map((text, index) => ({text, x: index * 100, y: 0, w: 30, h: 10}));
  const categories = equipmentCandidates(items).map(item => item.category);
  assert.deepEqual(new Set(categories), new Set(names))
});
