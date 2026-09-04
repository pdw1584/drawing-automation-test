/**
 * 자동 분석 결과와 사용자 교정값을 분리해 관리한다.
 * 키는 원문과 좌표로 만들기 때문에 분류명·판넬 규칙이 바뀌어도 같은 CAD 문자를 다시 찾을 수 있다.
 */
export function equipmentCorrectionKey(item) {
  const source = String(item.sourceName || item.name || "").trim().toLocaleUpperCase("ko-KR");
  const x = Number(item.x || 0).toFixed(2);
  const y = Number(item.y || 0).toFixed(2);
  return `${source}:${x}:${y}`
}

/** 확인 완료되지 않은 장비만 자동 문제 필터의 검토 대상으로 남긴다. */
export function isPendingEquipmentIssue(item) {
  return item?.reviewStatus !== "reviewed"
}

/** 선택된 장비의 교정값만 병합한다. 기존 판넬 교정과 검수 상태를 서로 덮어쓰지 않는다. */
export function updateEquipmentCorrections(equipment, corrections, selectedKeys, changes, updatedAt = new Date().toISOString()) {
  const next = {...(corrections || {})};
  for (const item of equipment || []) {
    const key = equipmentCorrectionKey(item);
    if (!selectedKeys.has(key)) continue;
    next[key] = {...(next[key] || {}), ...changes, updatedAt}
  }
  return next
}

export function applyEquipmentCorrections(equipment, corrections = {}, baseLabel = item => item.baseName || item.name) {
  return (equipment || []).map(item => {
    const key = equipmentCorrectionKey(item);
    const correction = corrections[key];
    const automaticPanelName = item.autoPanelName ?? item.panelName ?? "";
    const panelName = correction && Object.hasOwn(correction, "panelName")
      ? String(correction.panelName || "").trim()
      : automaticPanelName;
    const baseName = baseLabel(item);
    const panelCorrected = Boolean(correction && Object.hasOwn(correction, "panelName"));
    const userCorrected = Boolean(correction && (panelCorrected || correction.excluded));
    return {
      ...item,
      correctionKey: key,
      autoPanelName: automaticPanelName,
      autoPanelMatchConfidence: item.autoPanelMatchConfidence ?? item.panelMatchConfidence ?? (automaticPanelName ? "unknown" : "unmatched"),
      autoPanelMatchDistance: item.autoPanelMatchDistance ?? item.panelMatchDistance ?? null,
      panelName,
      name: panelName ? `${baseName} · ${panelName}` : baseName,
      userExcluded: Boolean(correction?.excluded),
      userCorrected,
      reviewStatus: correction?.reviewStatus || "unreviewed",
      panelMatchConfidence: panelCorrected ? (panelName ? "manual" : "unmatched") : (item.autoPanelMatchConfidence ?? item.panelMatchConfidence ?? (panelName ? "unknown" : "unmatched")),
      panelMatchDistance: panelCorrected ? null : (item.autoPanelMatchDistance ?? item.panelMatchDistance ?? null)
    }
  })
}
