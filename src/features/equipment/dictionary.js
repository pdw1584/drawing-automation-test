const STORAGE_KEY = "drawing-automation-custom-equipment-definitions";
const REVISION_KEY = "drawing-automation-equipment-dictionary-revision";
const BACKUP_KEY = "drawing-automation-custom-equipment-definitions-backup";

function normalizeDefinition(definition) {
  const name = String(definition?.name || "").trim();
  const aliases = [...new Set((definition?.aliases || [])
    .map(alias => String(alias).trim())
    .filter(Boolean))];
  if (name && !aliases.some(alias => alias.toLocaleUpperCase("ko-KR") === name.toLocaleUpperCase("ko-KR"))) {
    aliases.unshift(name)
  }
  return {name, aliases}
}

/** 브라우저별 사용자 사전을 읽되 손상된 JSON이나 빈 규칙은 안전하게 무시한다. */
export function loadCustomEquipmentDefinitions(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeDefinition).filter(item => item.name && item.aliases.length) : []
  } catch {
    return []
  }
}

/** 저장 직전 값을 한 단계 백업하고 사전 revision을 변경해 도면 재분석 필요 여부를 표시한다. */
export function saveCustomEquipmentDefinitions(definitions, storage = localStorage) {
  const normalized = definitions.map(normalizeDefinition).filter(item => item.name && item.aliases.length);
  const current = storage.getItem(STORAGE_KEY);
  if (current !== null && current !== JSON.stringify(normalized)) storage.setItem(BACKUP_KEY, current);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  storage.setItem(REVISION_KEY, String(Date.now()));
  return normalized
}

/** 직전 백업과 현재 사전을 교환하므로 복구 직후에도 다시 이전 상태로 돌아갈 수 있다. */
export function restoreCustomEquipmentDefinitions(storage = localStorage) {
  const backup = storage.getItem(BACKUP_KEY);
  if (!backup) return null;
  let definitions;
  try {
    definitions = JSON.parse(backup)
  } catch {
    return null
  }
  return saveCustomEquipmentDefinitions(Array.isArray(definitions) ? definitions : [], storage)
}

/** 다른 브라우저와 공유할 수 있도록 형식 식별자와 버전을 포함한 JSON을 생성한다. */
export function createEquipmentDictionaryExport(definitions) {
  return JSON.stringify({
    format: "drawing-automation-equipment-dictionary",
    version: 1,
    exportedAt: new Date().toISOString(),
    definitions: (definitions || []).map(normalizeDefinition).filter(item => item.name && item.aliases.length)
  }, null, 2)
}

/** 배열만 담긴 구형 파일과 메타데이터를 포함한 현재 파일을 모두 검증해 정규화한다. */
export function parseEquipmentDictionaryImport(source) {
  let parsed;
  try {
    parsed = typeof source === "string" ? JSON.parse(source) : source
  } catch {
    throw new Error("JSON 형식이 올바르지 않습니다.")
  }
  const definitions = Array.isArray(parsed) ? parsed : parsed?.definitions;
  if (!Array.isArray(definitions)) throw new Error("장비 사전 definitions 배열이 없습니다.");
  const normalized = definitions.map(normalizeDefinition).filter(item => item.name && item.aliases.length);
  if (!normalized.length) throw new Error("가져올 수 있는 장비 검출 규칙이 없습니다.");
  return normalized
}

/** 병합은 같은 분류의 별칭을 합치고, 교체는 프로젝트 기본 사전이 아닌 사용자 사전만 바꾼다. */
export function combineCustomEquipmentDefinitions(current, incoming, mode = "merge") {
  if (mode === "replace") return incoming.map(normalizeDefinition).filter(item => item.name && item.aliases.length);
  const combined = current.map(normalizeDefinition);
  for (const definition of incoming.map(normalizeDefinition)) {
    const existing = combined.find(item => item.name.toLocaleUpperCase("ko-KR") === definition.name.toLocaleUpperCase("ko-KR"));
    if (existing) existing.aliases = [...new Set([...existing.aliases, ...definition.aliases])];
    else combined.push(definition)
  }
  return combined
}

export function equipmentDictionaryRevision(storage = localStorage) {
  return storage.getItem(REVISION_KEY) || "0"
}

/** 기본 분류 순서를 보존하면서 사용자 별칭을 합치고 새 사용자 분류는 마지막에 추가한다. */
export function mergeEquipmentDefinitions(builtIn, custom) {
  const merged = (builtIn || []).map(normalizeDefinition);
  for (const definition of custom || []) {
    const normalized = normalizeDefinition(definition);
    if (!normalized.name) continue;
    const existing = merged.find(item => item.name.toLocaleUpperCase("ko-KR") === normalized.name.toLocaleUpperCase("ko-KR"));
    if (existing) existing.aliases = [...new Set([...existing.aliases, ...normalized.aliases])];
    else merged.push(normalized)
  }
  return merged
}
