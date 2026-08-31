/** TEXT/MTEXT 제어문자를 목록에서 읽을 수 있는 일반 문자열로 정리한다. */
export function cleanCadText(value) {
  return String(value || "")
    .replace(/\\S([^;]*);/gi, (_, stacked) => stacked.replace(/[#^]/g, "/"))
    .replace(/\\P/gi, " ")
    .replace(/\\~/g, " ")
    .replace(/\\[ACFHQTW][^;]*;/gi, "")
    .replace(/%%[A-Za-z]/g, "")
    .replace(/[{}]/g, "")
    .replace(/\uFFFD/g, " ")
    .replace(/\?{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
