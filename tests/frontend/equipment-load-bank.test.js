import test from "node:test";
import assert from "node:assert/strict";
import {configureEquipmentPriorities, equipmentCandidates} from "../../src/features/equipment/analysis.js";

configureEquipmentPriorities([
  {name: "Load Bank", aliases: ["LOAD BANK", "부하시험기", "로드 뱅크", "로드뱅크"]}
]);

test("로드 뱅크와 로드뱅크 한글 표기를 Load Bank로 검출한다", () => {
  const equipment = equipmentCandidates([
    {text: "로드 뱅크", x: 10, y: 20, w: 40, h: 10},
    {text: "로드뱅크", x: 50, y: 20, w: 40, h: 10}
  ]);

  assert.equal(equipment.length, 2);
  assert.deepEqual(equipment.map(item => item.category), ["Load Bank", "Load Bank"]);
});
