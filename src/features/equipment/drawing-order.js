/** 기존 도면은 등록일 역순을 사용하고, 저장된 순서가 있으면 그 값을 우선한다. */
export function normalizeDrawingOrder(drawings) {
  const ordered = [...(drawings || [])].sort((first, second) => {
    const firstHasOrder = Number.isFinite(first.sortOrder);
    const secondHasOrder = Number.isFinite(second.sortOrder);
    if (firstHasOrder && secondHasOrder) return first.sortOrder - second.sortOrder;
    if (firstHasOrder !== secondHasOrder) return firstHasOrder ? -1 : 1;
    return String(second.createdAt || "").localeCompare(String(first.createdAt || ""))
  });
  return ordered.map((drawing, index) => ({...drawing, sortOrder: index}))
}

/** 지정한 도면을 한 칸 이동하고 연속된 순서 번호를 다시 부여한다. */
export function moveDrawing(drawings, drawingId, direction) {
  const ordered = normalizeDrawingOrder(drawings);
  const currentIndex = ordered.findIndex(drawing => drawing.id === drawingId);
  if (currentIndex < 0) return ordered;
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= ordered.length) return ordered;
  [ordered[currentIndex], ordered[targetIndex]] = [ordered[targetIndex], ordered[currentIndex]];
  return ordered.map((drawing, index) => ({...drawing, sortOrder: index}))
}
