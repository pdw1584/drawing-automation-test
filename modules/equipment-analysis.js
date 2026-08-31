let equipmentPriorities = [];

const PANEL_LINK_CATEGORIES = new Set(["UPS", "STS", "Battery", "변압기", "HV", "LV", "RF"]);

export function configureEquipmentPriorities(priorities) {
  equipmentPriorities = priorities
}

export function cleanCadText(value) {
  return value
    .replace(/\\P/gi, " ")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/%%[A-Za-z]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/\?{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function equipmentPriority(name) {
  const upperName = name.toLocaleUpperCase("ko-KR");
  for (let index = 0; index < equipmentPriorities.length; index++) {
    const definition = equipmentPriorities[index];
    for (const rawAlias of definition.aliases) {
      const alias = rawAlias.toLocaleUpperCase("ko-KR").trim();
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matched = alias.length <= 3
        ? new RegExp(`(^|[^A-Z0-9가-힣])${escapedAlias}([^A-Z0-9가-힣]|$)`).test(upperName)
        : upperName.replace(/[\s_-]/g, "").includes(alias.replace(/[\s_-]/g, ""));
      if (matched) return {priority: index, category: definition.name}
    }
  }
  return {priority: Number.MAX_SAFE_INTEGER, category: ""}
}

export function equipmentLabel(sourceName, classification) {
  const upperName = sourceName.toLocaleUpperCase("ko-KR");
  const definition = equipmentPriorities[classification.priority];
  const latinAliases = (definition?.aliases || []).filter(alias => /^[A-Z0-9 /-]+$/i.test(alias));
  const tags = upperName.match(/[A-Z0-9]+(?:[-_][A-Z0-9]+)+/g) || [];
  const tagged = tags.find(tag => latinAliases.some(alias => {
    const token = alias.toUpperCase().replace(/[\s/]/g, "");
    return token.length >= 2 && tag.replace(/[_-]/g, "").includes(token)
  }));
  return tagged || classification.category
}

function panelNameFromText(value) {
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const matches = text.match(/(?:B?\d{1,2}F|RF|PH)(?:\s*[-_/]\s*[A-Z0-9]{1,8}){1,4}/g) || [];
  const match = matches.find(name => !/(?:UPS|STS|BAT|TR)/.test(name));
  return match ? match.replace(/\s*[-_/]\s*/g, "-") : ""
}

function rfPanelNameFromText(value) {
  const text = cleanCadText(value).toLocaleUpperCase("ko-KR");
  const match = text.match(/(?:^|[^A-Z0-9])(\d{1,3}[A-Z](?:\s*[-_/]\s*\d{1,3})?)(?:[^A-Z0-9]|$)/);
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
  if (!panels.length && !rfPanels.length) return equipment;

  const linkable = equipment.filter(item => PANEL_LINK_CATEGORIES.has(item.category));
  for (const item of linkable) {
    const panelCandidates = item.category === "RF" ? rfPanels : panels;
    const nearestPanel = panelCandidates.map(panel => ({panel, distance: distanceBetween(item, panel)}))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearestPanel) continue;

    const nearestPeerDistance = linkable.filter(peer => peer !== item && distanceBetween(item, peer) > .001)
      .reduce((nearest, peer) => Math.min(nearest, distanceBetween(item, peer)), Number.POSITIVE_INFINITY);
    const textScaleLimit = Math.max(item.height || 0, nearestPanel.panel.h || 0, 1) * 100;
    const peerLimit = Number.isFinite(nearestPeerDistance) ? nearestPeerDistance * 2 : 0;
    if (nearestPanel.distance > Math.max(textScaleLimit, peerLimit)) continue;

    item.panelName = nearestPanel.panel.panelName;
    item.name = `${item.name} · ${item.panelName}`
  }
  return equipment
}

function equipmentCandidates(textItems) {
  const seen = new Set(), equipment = [];
  for (const item of textItems || []) {
    const name = cleanCadText(item.text || "");
    if (name.length < 2 || name.length > 100) continue;
    if (!/[A-Za-z가-힣]/.test(name) || /^[-+Ø⌀]?\d+(?:[.,x×*/-]\d+)*\s*(?:mm|cm|m|a|v|kw|t)?$/i.test(name)) continue;
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
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../review-dxf-worker.js", import.meta.url), {type: "module"});
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
