import test from "node:test";
import assert from "node:assert/strict";
import {cloneDrawing, compare, parseDxf, translateDrawing} from "../../src/features/compare/engine.js";

function drawing(entityText) {
  return parseDxf(`0\nSECTION\n2\nENTITIES\n${entityText}\n0\nENDSEC\n0\nEOF\n`, "test.dxf")
}

test("DXF 문자와 레이어 제어문자를 정리해 파싱한다", () => {
  const result = drawing("0\nTEXT\n8\nNOTE\n10\n10\n20\n20\n40\n3\n1\n{\\Fbatang;%%U장비\\P명}");
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].text, "장비 명")
});

test("동일 도면은 변경 항목이 없다", () => {
  const original = drawing("0\nLINE\n8\nPIPE\n10\n0\n20\n0\n11\n10\n21\n0");
  assert.deepEqual(compare(original, cloneDrawing(original)), [])
});

test("추가 및 삭제 객체를 구분한다", () => {
  const original = drawing("0\nLINE\n8\nPIPE\n10\n0\n20\n0\n11\n10\n21\n0");
  const revised = drawing("0\nCIRCLE\n8\nEQUIP\n10\n50\n20\n50\n40\n5");
  const kinds = compare(original, revised).map(item => item.kind).sort();
  assert.deepEqual(kinds, ["added", "removed"])
});

test("도면 평행이동은 복제본에만 적용한다", () => {
  const original = drawing("0\nPOINT\n8\nGRID\n10\n1\n20\n2");
  const moved = translateDrawing(cloneDrawing(original), 10, -5);
  assert.deepEqual(original.entities[0].points[0], {x: 1, y: 2});
  assert.deepEqual(moved.entities[0].points[0], {x: 11, y: -3})
});
