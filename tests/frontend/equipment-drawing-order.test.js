import test from "node:test";
import assert from "node:assert/strict";
import {moveDrawing, normalizeDrawingOrder} from "../../src/features/equipment/drawing-order.js";

test("기존 등록 도면은 최신 등록일 순서로 초기화한다", () => {
  const drawings = normalizeDrawingOrder([
    {id: "old", createdAt: "2026-01-01T00:00:00.000Z"},
    {id: "new", createdAt: "2026-02-01T00:00:00.000Z"}
  ]);
  assert.deepEqual(drawings.map(item => item.id), ["new", "old"]);
  assert.deepEqual(drawings.map(item => item.sortOrder), [0, 1]);
});

test("등록 도면을 위아래 한 칸 이동하고 순서 번호를 다시 지정한다", () => {
  const drawings = [
    {id: "first", sortOrder: 0},
    {id: "second", sortOrder: 1},
    {id: "third", sortOrder: 2}
  ];
  const movedUp = moveDrawing(drawings, "third", "up");
  assert.deepEqual(movedUp.map(item => item.id), ["first", "third", "second"]);
  assert.deepEqual(movedUp.map(item => item.sortOrder), [0, 1, 2]);
  const movedDown = moveDrawing(movedUp, "first", "down");
  assert.deepEqual(movedDown.map(item => item.id), ["third", "first", "second"]);
});

test("첫 번째와 마지막 도면은 목록 경계 밖으로 이동하지 않는다", () => {
  const drawings = [{id: "first", sortOrder: 0}, {id: "last", sortOrder: 1}];
  assert.deepEqual(moveDrawing(drawings, "first", "up").map(item => item.id), ["first", "last"]);
  assert.deepEqual(moveDrawing(drawings, "last", "down").map(item => item.id), ["first", "last"]);
});
