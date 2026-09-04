import test from "node:test";
import assert from "node:assert/strict";
import {
  combineCustomEquipmentDefinitions,
  createEquipmentDictionaryExport,
  equipmentDictionaryRevision,
  loadCustomEquipmentDefinitions,
  mergeEquipmentDefinitions,
  parseEquipmentDictionaryImport,
  restoreCustomEquipmentDefinitions,
  saveCustomEquipmentDefinitions
} from "../../src/features/equipment/dictionary.js";
import {configureEquipmentPriorities, equipmentCandidates} from "../../src/features/equipment/analysis.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  }
}

test("사용자 장비 검출 규칙을 저장하고 다시 불러온다", () => {
  const storage = memoryStorage();
  saveCustomEquipmentDefinitions([{name: "ATS", aliases: ["ATS", "AUTO TRANSFER SWITCH"]}], storage);
  assert.deepEqual(loadCustomEquipmentDefinitions(storage), [
    {name: "ATS", aliases: ["ATS", "AUTO TRANSFER SWITCH"]}
  ]);
  assert.notEqual(equipmentDictionaryRevision(storage), "0");
});

test("같은 분류의 사용자 별칭은 기본 사전에 병합된다", () => {
  const merged = mergeEquipmentDefinitions(
    [{name: "UPS", aliases: ["UPS"]}],
    [{name: "UPS", aliases: ["UNINTERRUPTIBLE POWER SUPPLY"]}, {name: "ATS", aliases: ["ATS"]}]
  );
  assert.deepEqual(merged, [
    {name: "UPS", aliases: ["UPS", "UNINTERRUPTIBLE POWER SUPPLY"]},
    {name: "ATS", aliases: ["ATS"]}
  ]);
});

test("사용자 등록 분류와 약어가 자동 장비 검출에 적용된다", () => {
  const definitions = mergeEquipmentDefinitions([], [{name: "ATS", aliases: ["ATS"]}]);
  configureEquipmentPriorities(definitions);
  const equipment = equipmentCandidates([{text: "ATS", x: 10, y: 20, w: 20, h: 10}]);
  assert.equal(equipment.length, 1);
  assert.equal(equipment[0].category, "ATS");
});

test("사용자 장비 사전을 JSON으로 내보내고 검증해 가져온다", () => {
  const json = createEquipmentDictionaryExport([{name: "ATS", aliases: ["ATS", "자동절체개폐기"]}]);
  const imported = parseEquipmentDictionaryImport(json);
  assert.deepEqual(imported, [{name: "ATS", aliases: ["ATS", "자동절체개폐기"]}]);
  assert.throws(() => parseEquipmentDictionaryImport('{"wrong":[]}'), /definitions/);
});

test("가져온 사전을 병합 또는 전체 교체하고 이전 상태를 복구한다", () => {
  const current = [{name: "UPS", aliases: ["UPS"]}];
  const incoming = [{name: "UPS", aliases: ["무정전전원장치"]}, {name: "ATS", aliases: ["ATS"]}];
  assert.deepEqual(combineCustomEquipmentDefinitions(current, incoming, "merge"), [
    {name: "UPS", aliases: ["UPS", "무정전전원장치"]},
    {name: "ATS", aliases: ["ATS"]}
  ]);
  assert.deepEqual(combineCustomEquipmentDefinitions(current, incoming, "replace"), [
    {name: "UPS", aliases: ["UPS", "무정전전원장치"]},
    {name: "ATS", aliases: ["ATS"]}
  ]);

  const storage = memoryStorage();
  saveCustomEquipmentDefinitions(current, storage);
  saveCustomEquipmentDefinitions(incoming, storage);
  assert.deepEqual(restoreCustomEquipmentDefinitions(storage), current);
});
