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

export function detectDxfEncoding(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return {encoding: "utf-8", codepage: "UTF-8"};
  const header = new TextDecoder("windows-1252").decode(bytes.subarray(0, Math.min(bytes.length, 262144)));
  const match = header.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/i);
  const codepage = match?.[1].trim().toUpperCase() || "";
  if (CODEPAGE_LABELS.has(codepage)) return {encoding: CODEPAGE_LABELS.get(codepage), codepage};
  const ansiMatch = codepage.match(/^ANSI_(\d+)$/);
  if (ansiMatch) return {encoding: `windows-${ansiMatch[1]}`, codepage};
  return detectUtf8(bytes) ? {encoding: "utf-8", codepage: codepage || "UTF-8"} : {encoding: "euc-kr", codepage: codepage || "CP949 추정"}
}

export function decodeDxfBuffer(buffer) {
  const detected = detectDxfEncoding(buffer);
  let decoder;
  try {
    decoder = new TextDecoder(detected.encoding)
  } catch {
    detected.encoding = "utf-8";
    decoder = new TextDecoder("utf-8")
  }
  const text = decoder.decode(buffer).replace(/\\U\+([0-9A-F]{4,8})/gi, (match, hexadecimal) => {
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
