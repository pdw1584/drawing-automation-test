import test from "node:test";
import assert from "node:assert/strict";
import {configureEquipmentPriorities, equipmentCandidates} from "../../src/features/equipment/analysis.js";

configureEquipmentPriorities([{name: "UPS", aliases: ["UPS"]}]);

test("panel matching exposes distance and confidence metadata", () => {
  const [equipment] = equipmentCandidates([
    {text: "UPS", x: 100, y: 100, w: 20, h: 10},
    {text: "5F-1D-3", x: 112, y: 100, w: 40, h: 10}
  ]);

  assert.equal(equipment.panelName, "5F-1D-3");
  assert.equal(equipment.panelMatchDistance, 12);
  assert.equal(equipment.panelMatchConfidence, "high");
  assert.ok(equipment.panelMatchLimit >= equipment.panelMatchDistance);
});
