/** 사용자 파일명이나 도면 문구를 HTML에 넣기 전에 실행 가능한 문자를 이스케이프한다. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character])
}

/** 모든 화면에서 동일한 단위와 정밀도로 파일 크기를 표시한다. */
export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
