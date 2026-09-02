const CODEPAGE_LABELS = new Map([
  ["UTF-8", "utf-8"],
  ["UTF8", "utf-8"],
  ["ANSI_949", "euc-kr"],
  ["DOS949", "euc-kr"],
  ["KSC5601", "euc-kr"],
  ["ANSI_936", "gbk"],
  ["DOS936", "gbk"],
  ["ANSI_932", "shift_jis"],
  ["DOS932", "shift_jis"],
  ["ANSI_950", "big5"],
  ["DOS950", "big5"]
]);

function detectUtf8(bytes) {
  try {
    new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    return true
  } catch {
    return false
  }
}

// 후보 디코딩 결과를 사람이 읽을 수 있는 정도로 평가한다. 대체문자와 UTF-8
// 모지바케 흔적은 크게 감점해 헤더 코드페이지가 잘못된 국내 DXF도 보정한다.
function decodedTextQuality(value) {
  const hangul = (value.match(/[가-힣]/g) || []).length;
  const replacement = (value.match(/\uFFFD/g) || []).length;
  const mojibake = (value.match(/[ÃÂ]|(?:ê|ë|ì|í)[\u0080-\u00ff]/g) || []).length;
  const control = (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) || []).length;
  return hangul * 3 - replacement * 30 - mojibake * 8 - control * 5
}

export function detectDxfEncoding(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return {encoding: "utf-8", codepage: "UTF-8"};
  const validUtf8 = detectUtf8(bytes);
  const header = new TextDecoder("windows-1252").decode(bytes.subarray(0, Math.min(bytes.length, 262144)));
  const match = header.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/i);
  const codepage = match?.[1].trim().toUpperCase() || "";
  const hasNonAscii = bytes.some(byte => byte >= 0x80);
  const frequentlyMisdeclared = new Set(["ANSI_1252", "ANSI_949", "DOS949", "KSC5601"]);
  // 전체 바이트가 엄격한 UTF-8이고 실제 비ASCII 문자가 존재하면 바이트 자체가 가장
  // 강한 근거다. 특히 UTF-8 한글인데 헤더만 ANSI_949인 변환 도면이 자주 발생한다.
  if (validUtf8 && hasNonAscii && (!codepage || frequentlyMisdeclared.has(codepage))) {
    return {encoding: "utf-8", codepage: codepage ? `${codepage} → UTF-8 보정` : "UTF-8"}
  }
  if (CODEPAGE_LABELS.has(codepage)) return {encoding: CODEPAGE_LABELS.get(codepage), codepage};
  // 일부 프로그램은 실제 UTF-8 DXF에도 ANSI_1252를 기록한다. UTF-8 바이트 검증을
  // 통과한 파일을 CP949 후보로 다시 해석하면 `지하층`이 `移쒖...`처럼 변형된다.
  if (validUtf8 && (!codepage || codepage === "ANSI_1252")) {
    return {encoding: "utf-8", codepage: codepage ? `${codepage} → UTF-8 보정` : "UTF-8"}
  }
  const ansiMatch = codepage.match(/^ANSI_(\d+)$/);
  if (ansiMatch) return {encoding: `windows-${ansiMatch[1]}`, codepage};
  return validUtf8 ? {encoding: "utf-8", codepage: codepage || "UTF-8"} : {encoding: "euc-kr", codepage: codepage || "CP949 추정"}
}

export function decodeDxfBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const detected = detectDxfEncoding(buffer);
  let decoder;
  try {
    decoder = new TextDecoder(detected.encoding)
  } catch {
    detected.encoding = "utf-8";
    decoder = new TextDecoder("utf-8")
  }
  let decodedText = decoder.decode(buffer);
  const validUtf8 = detectUtf8(bytes);
  if (detected.encoding !== "euc-kr" && detected.encoding !== "utf-8" && !validUtf8 && bytes.some(byte => byte >= 0x80)) {
    const koreanCandidate = new TextDecoder("euc-kr").decode(buffer);
    const candidateHangul = (koreanCandidate.match(/[가-힣]/g) || []).length;
    if (candidateHangul >= 2 && decodedTextQuality(koreanCandidate) > decodedTextQuality(decodedText) + 3) {
      decodedText = koreanCandidate;
      detected.encoding = "euc-kr";
      detected.codepage = `${detected.codepage} → CP949 보정`
    }
  }
  const text = decodedText.replace(/\\U\+([0-9A-F]{4,8})/gi, (match, hexadecimal) => {
    const codePoint = Number.parseInt(hexadecimal, 16);
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return match
    }
  });
  return {...detected, text}
}

export async function decodeDxfFile(file) {
  return decodeDxfBuffer(await file.arrayBuffer())
}
