import {cleanCadText} from "../../shared/dxf-text.js";

let equipmentPriorities = [];

// 판넬명이 장비 약어와 별도 TEXT/MTEXT 객체로 작성되는 장비만 좌표 기반 연결을 수행한다.
// 다른 장비까지 무조건 연결하면 근처의 층/구역 표기가 잘못 붙을 가능성이 높다.
const PANEL_LINK_CATEGORIES = new Set(["UPS", "STS", "CTTS", "Battery", "변압기", "TR", "SC", "MHV", "HV", "LV", "RF"]);

/** 서버의 equipment-priority.json을 분석 모듈에 주입한다. 배열 순서가 목록 정렬 우선순위다. */
export function configureEquipmentPriorities(priorities) {
  equipmentPriorities = priorities
}

export {cleanCadText};

function isStrictTrEquipmentName(value) {
  // TR은 도면의 중량·전압·다른 장비 설명 앞에도 자주 등장하므로 일반 부분 검색을 쓰지 않는다.
  // 단독 장비명 또는 A-6F-TR-01처럼 '-'/'_'로 분리된 구조화 태그만 인정한다.
  const upper = cleanCadText(value).toLocaleUpperCase("ko-KR").trim();
  if (["TR", "TRANSFORMER", "변압기"].includes(upper)) return true;
  if (/\s/.test(upper) || !/\d/.test(upper)) return false;
  const tokens = upper.split(/[-_]/).filter(Boolean);
  return tokens.length >= 2 && tokens.includes("TR")
}

export function equipmentPriority(name) {
  const upperName = name.toLocaleUpperCase("ko-KR");
  for (let index = 0; index < equipmentPriorities.length; index++) {
    const definition = equipmentPriorities[index];
    for (const rawAlias of definition.aliases) {
      const alias = rawAlias.toLocaleUpperCase("ko-KR").trim();
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // UPS, TR처럼 짧은 약어는 단어 경계를 강제한다. 부분 문자열 검색을 쓰면
      // STS가 긴 일반 영문 단어 내부에서 검출되는 식의 오탐이 크게 증가한다.
      const matched = alias.length <= 3
        ? new RegExp(`(^|[^A-Z0-9가-힣])${escapedAlias}([^A-Z0-9가-힣]|$)`).test(upperName)
        : upperName.replace(/[\s_-]/g, "").includes(alias.replace(/[\s_-]/g, ""));
      if (matched) {
        if (definition.name === "TR" && !isStrictTrEquipmentName(name)) continue;
        return {priority: index, category: definition.name}
      }
    }
  }
  return {priority: Number.MAX_SAFE_INTEGER, category: ""}
}

export function equipmentLabel(sourceName, classification) {
  const upperName = sourceName.toLocaleUpperCase("ko-KR");
  const definition = equipmentPriorities[classification.priority];
  const latinAliases = (definition?.aliases || []).filter(alias => /^[A-Z0-9 /-]+$/i.test(alias));
  const tags = upperName.match(/[A-Z0-9]+(?:[-_][A-Z0-9]+)+/g) || [];
  // A-3F-CWU-01처럼 장비 약어가 포함된 태그가 있으면 분류명(CWU)보다 태그를 우선 표시한다.
  const tagged = tags.find(tag => latinAliases.some(alias => {
    const token = alias.toUpperCase().replace(/[\s/]/g, "");
    return token.length >= 2 && tag.replace(/[_-]/g, "").includes(token)
  }));
  return tagged || classification.category
}

function panelNameFromText(value) {
  // 일반 판넬 표기: 5F-1D-3, 5F_1D_3, 5F/1D/3 등을 하나의 형식으로 정규화한다.
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  // 6층 전산실 계통은 층 번호 대신 CR 또는 CRB로 시작한다.
  const matches = text.match(/(?:CRB?|B?\d{1,2}F|RF|PH)(?:\s*[-_/]\s*[A-Z0-9]{1,8}){1,4}/g) || [];
  const match = matches.find(name => !/(?:UPS|STS|BAT|TR)/.test(name));
  return match ? match.replace(/\s*[-_/]\s*/g, "-") : ""
}

function rfPanelNameFromText(value) {
  // RF 옆 표기는 층 접두어 없이 2A 또는 2A-1 형태이므로 일반 판넬 규칙과 분리한다.
  // 분리하지 않으면 RF가 멀리 있는 UPS 판넬(예: 3F-1B-7)을 선택할 수 있다.
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const match = text.match(/(?:^|[^A-Z0-9])(\d{1,3}[A-Z](?:\s*[-_/]\s*\d{1,3})?)(?:[^A-Z0-9]|$)/);
  return match ? match[1].replace(/\s*[-_/]\s*/g, "-") : ""
}

function shortElectricalPanelNameFromText(value) {
  // 일부 층의 UPS/Battery/CTTS/MHV/LV/HV/SC 판넬은 층/CR 접두어 없이 다음과 같은 단축 형식을 사용한다.
  // 1A-PT, 1A-1, 1C, C1-PT, C1-1, BU-1-PT, OM-1, OF-1, 1BB, 1BA
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const match = text.match(/(?:^|[^A-Z0-9])((?:\d{1,3}[A-Z]\s*[-_/]\s*(?:PT|\d{1,3})|[A-Z]{1,4}\d{1,3}\s*[-_/]\s*(?:PT|\d{1,3})|[A-Z]{1,4}\s*[-_/]\s*\d{1,3}(?:\s*[-_/]\s*PT)?|\d{1,3}[A-Z]{1,2}))(?:[^A-Z0-9]|$)/);
  return match ? match[1].replace(/\s*[-_/]\s*/g, "-") : ""
}

const distanceBetween = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

function attachNearbyPanelNames(equipment, textItems) {
  const panels = (textItems || []).map(item => ({...item, panelName: panelNameFromText(item.text || "")}))
    .filter(item => item.panelName);
  const rfPanels = (textItems || []).map(item => ({
    ...item,
    panelName: panelNameFromText(item.text || "") ? "" : rfPanelNameFromText(item.text || "")
  })).filter(item => item.panelName);
  const shortElectricalPanels = (textItems || []).map(item => ({
    ...item,
    panelName: panelNameFromText(item.text || "") ? "" : shortElectricalPanelNameFromText(item.text || "")
  })).filter(item => item.panelName);
  if (!panels.length && !rfPanels.length && !shortElectricalPanels.length) return equipment;

  const linkable = equipment.filter(item => PANEL_LINK_CATEGORIES.has(item.category));
  // 일반 형식과 단축 전기 형식의 판넬 후보를 한곳에서 결합해 모든 연결 대상에 공통 적용한다.
  // 후보 생성과 장비별 선택을 분리해 판넬 형식이 추가돼도 거리·신뢰도 계산은 그대로 재사용한다.
  const broadPanelCandidates = [...panels, ...shortElectricalPanels];
  for (const item of linkable) {
    // RF는 짧은 구역 번호만, 나머지는 층이 포함된 판넬명만 후보로 사용한다.
    // RF는 기존 층에서 짧은 구역 번호를 사용하지만, 6층에서는 인접한 CR/CRB
    // 판넬도 후보에 포함한다. 최종 선택은 실제 도면 좌표상 거리로 결정한다.
    const crPanels = panels.filter(panel => /^CRB?(?:-|$)/.test(panel.panelName));
    const panelCandidates = item.category === "RF"
      ? [...crPanels, ...rfPanels]
      : broadPanelCandidates;
    const rankedPanels = panelCandidates.map(panel => ({panel, distance: distanceBetween(item, panel)}))
      .sort((a, b) => a.distance - b.distance);
    const nearestPanel = rankedPanels[0];
    if (!nearestPanel) continue;

    // 도면마다 단위(mm 등)와 문자 높이가 다르므로 고정 거리 대신 문자 크기와
    // 인접 장비 간격을 함께 사용한다. 동일 좌표 중복 객체는 간격 계산에서 제외한다.
    const nearestPeerDistance = linkable.filter(peer => peer !== item && distanceBetween(item, peer) > .001)
      .reduce((nearest, peer) => Math.min(nearest, distanceBetween(item, peer)), Number.POSITIVE_INFINITY);
    const textScaleLimit = Math.max(item.height || 0, nearestPanel.panel.h || 0, 1) * 100;
    const peerLimit = Number.isFinite(nearestPeerDistance) ? nearestPeerDistance * 2 : 0;
    const distanceLimit = Math.max(textScaleLimit, peerLimit);
    if (nearestPanel.distance > distanceLimit) continue;

    item.panelName = nearestPanel.panel.panelName;
    item.name = `${item.name} · ${item.panelName}`;
    item.panelMatchDistance = nearestPanel.distance;
    item.panelMatchLimit = distanceLimit;
    item.panelCandidateCount = rankedPanels.length;
    const distanceRatio = nearestPanel.distance / Math.max(distanceLimit, 1);
    const secondDistance = rankedPanels[1]?.distance ?? Number.POSITIVE_INFINITY;
    const ambiguous = secondDistance <= nearestPanel.distance * 1.25 + Math.max(item.height || 1, 1) * 2;
    item.panelMatchConfidence = distanceRatio <= .35 && !ambiguous
      ? "high"
      : distanceRatio <= .72 && !ambiguous
        ? "medium"
        : "low"
  }
  return equipment
}

export function equipmentCandidates(textItems) {
  const seen = new Set(), equipment = [];
  for (const item of textItems || []) {
    const name = cleanCadText(item.text || "");
    if (name.length < 2 || name.length > 100) continue;
    if (!/[A-Za-z가-힣]/.test(name) || /^[-+Ø⌀]?\d+(?:[.,x×*/-]\d+)*\s*(?:mm|cm|m|a|v|kw|t)?$/i.test(name)) continue;
    // 같은 문구가 여러 블록에서 반복될 수 있으므로 이름과 좌표가 모두 같은 경우만 중복 처리한다.
    const key = `${name.toUpperCase()}:${item.x.toFixed(2)}:${item.y.toFixed(2)}`;
    if (seen.has(key)) continue;
    const classification = equipmentPriority(name);
    if (classification.priority === Number.MAX_SAFE_INTEGER) continue;
    const label = equipmentLabel(name, classification);
    seen.add(key);
    equipment.push({name: label, sourceName: name, x: item.x, y: item.y, width: item.w, height: item.h, ...classification})
  }
  return attachNearbyPanelNames(equipment, textItems)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "ko", {numeric: true}))
}

export function analyzeDxf(file) {
  // 수십~수백 MB DXF의 파싱이 UI 스레드를 막지 않도록 전용 Worker에서 수행한다.
  // Worker에서는 텍스트와 변환된 블록 좌표만 반환하고 분류/판넬 연결은 여기서 마무리한다.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../workers/review-dxf-worker.js", import.meta.url), {type: "module"});
    worker.onmessage = event => {
      worker.terminate();
      if (event.data?.error) reject(new Error(event.data.error));
      else resolve({codepage: event.data.codepage, equipment: equipmentCandidates(event.data.preview?.textItems)})
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || "DXF 장비명 분석 Worker 실행에 실패했습니다."))
    };
    worker.postMessage({file})
  })
}
