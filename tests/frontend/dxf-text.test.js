import test from "node:test";
import assert from "node:assert/strict";
import {cleanCadText} from "../../src/shared/dxf-text.js";
import {decodeDxfBuffer} from "../../src/shared/dxf-encoding.js";

test("MTEXT 제어문자와 분수 표기를 정리한다", () => {
  assert.equal(cleanCadText("{\\Fbatang|b0;%%U장비\\P\\S1#2;}"), "장비 1/2")
});

test("ANSI_1252로 잘못 선언된 UTF-8 한글을 보존한다", () => {
  const source = "0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_1252\n0\nENDSEC\n0\nTEXT\n8\n지하층 판넬\n1\n한글 정상\n";
  const bytes = new TextEncoder().encode(source);
  const result = decodeDxfBuffer(bytes.buffer);
  assert.equal(result.encoding, "utf-8");
  assert.match(result.text, /지하층 판넬/);
  assert.doesNotMatch(result.text, /移쒖/)
});

test("ANSI_949로 잘못 선언된 UTF-8 한글도 실제 바이트를 우선한다", () => {
  const source = "0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_949\n0\nENDSEC\n0\nTEXT\n8\n운영동 옥상\n1\n로드뱅크 하중\n";
  const bytes = new TextEncoder().encode(source);
  const result = decodeDxfBuffer(bytes.buffer);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.codepage, "ANSI_949 → UTF-8 보정");
  assert.match(result.text, /운영동 옥상/);
  assert.match(result.text, /로드뱅크 하중/)
});
