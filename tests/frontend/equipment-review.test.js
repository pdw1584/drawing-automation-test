import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEquipmentCorrections,
  equipmentCorrectionKey,
  isPendingEquipmentIssue,
  updateEquipmentCorrections
} from "../../src/features/equipment/corrections.js";

const equipment = [
  {sourceName: "UPS", name: "UPS · 1A-1", panelName: "1A-1", panelMatchConfidence: "high", panelMatchDistance: 12, x: 10, y: 20},
  {sourceName: "HV", name: "HV · 1B-1", panelName: "1B-1", panelMatchConfidence: "medium", panelMatchDistance: 20, x: 30, y: 40}
];

test("검수 상태만 저장하면 자동 판넬 신뢰도와 거리를 유지한다", () => {
  const key = equipmentCorrectionKey(equipment[0]);
  const [reviewed] = applyEquipmentCorrections(equipment, {[key]: {reviewStatus: "reviewed"}}, item => item.sourceName);
  assert.equal(reviewed.reviewStatus, "reviewed");
  assert.equal(reviewed.panelMatchConfidence, "high");
  assert.equal(reviewed.panelMatchDistance, 12);
  assert.equal(reviewed.userCorrected, false);
});

test("여러 장비를 일괄 제외해도 기존 교정값을 보존한다", () => {
  const firstKey = equipmentCorrectionKey(equipment[0]);
  const secondKey = equipmentCorrectionKey(equipment[1]);
  const updated = updateEquipmentCorrections(
    equipment,
    {[firstKey]: {panelName: "1A-2", reviewStatus: "needs_revision"}},
    new Set([firstKey, secondKey]),
    {excluded: true},
    "2026-09-02T00:00:00.000Z"
  );
  assert.equal(updated[firstKey].panelName, "1A-2");
  assert.equal(updated[firstKey].reviewStatus, "needs_revision");
  assert.equal(updated[firstKey].excluded, true);
  assert.equal(updated[secondKey].excluded, true);
});

test("확인 완료 장비는 문제 필터에서 숨고 미검토 전환 시 다시 표시된다", () => {
  assert.equal(isPendingEquipmentIssue({reviewStatus: "reviewed"}), false);
  assert.equal(isPendingEquipmentIssue({reviewStatus: "unreviewed"}), true);
  assert.equal(isPendingEquipmentIssue({reviewStatus: "needs_revision"}), true);
  assert.equal(isPendingEquipmentIssue({}), true);
});
