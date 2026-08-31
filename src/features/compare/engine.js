// 순수 DXF 파싱·기하·정렬·비교 엔진입니다.
// DOM, iframe, 네트워크, 화면 전역 상태를 참조하지 않도록 유지합니다.

import {cleanCadText} from "../../shared/dxf-text.js";

// -----------------------------------------------------------------------------
// DXF 파싱 및 블록 전개
// DXF는 group code/value 두 줄이 한 쌍이다. 필요한 엔티티만 가벼운 객체로 변환해
// 비교 단계에서 원본 텍스트 전체를 계속 순회하지 않도록 한다.
// -----------------------------------------------------------------------------
function pairs(text) {
  const lines = text.replace(/\r/g, "").split("\n"),
    out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([lines[i].trim(), lines[i + 1].trim()]);
  return out
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0
}

function parseBlockDefinitions(sourcePairs) {
  // BLOCKS 섹션을 먼저 읽어 INSERT가 참조하는 원형을 만든다. 블록 내부 엔티티도
  // 동일한 parseDxf 경로를 사용해 일반 ENTITIES와 결과 구조를 일치시킨다.
  const blocks = new Map();
  let inBlocks = false;
  for (let index = 0; index < sourcePairs.length; index++) {
    const [code, value] = sourcePairs[index];
    if (code === "2" && value === "BLOCKS") {
      inBlocks = true;
      continue
    }
    if (inBlocks && code === "0" && value === "ENDSEC") break;
    if (!inBlocks || code !== "0" || value !== "BLOCK") continue;
    let end = index + 1;
    while (end < sourcePairs.length && !(sourcePairs[end][0] === "0" && sourcePairs[end][1] === "ENDBLK")) end++;
    const content = sourcePairs.slice(index + 1, end);
    const firstEntity = content.findIndex(([itemCode]) => itemCode === "0");
    const header = firstEntity >= 0 ? content.slice(0, firstEntity) : content;
    const entityPairs = firstEntity >= 0 ? content.slice(firstEntity) : [];
    const blockName = header.find(([itemCode]) => itemCode === "2")?.[1];
    if (blockName) {
      const baseX = num(header.find(([itemCode]) => itemCode === "10")?.[1]), baseY = num(header.find(([itemCode]) => itemCode === "20")?.[1]);
      const entityText = entityPairs.flatMap(pair => pair).join("\n");
      const synthetic = `0\nSECTION\n2\nENTITIES\n${entityText}\n0\nENDSEC\n0\nEOF\n`;
      blocks.set(blockName, {name: blockName, base: {x: baseX, y: baseY}, entities: parseDxf(synthetic, blockName, false).entities})
    }
    index = end
  }
  return blocks
}

function transformBlockEntity(source, insert, base) {
  // 블록 기준점 기준으로 축척 → 회전 → 삽입점 이동 순서로 월드 좌표를 계산한다.
  // 원본 블록 객체는 다른 INSERT도 공유하므로 반드시 복제한 뒤 변환한다.
  const entity = {...source, points: source.points.map(point => ({...point}))}, angle = (insert.rotation || 0) * Math.PI / 180,
    cos = Math.cos(angle), sin = Math.sin(angle), scaleX = insert.scaleX ?? 1, scaleY = insert.scaleY ?? 1, origin = insert.points[0] || {x: 0, y: 0};
  for (const point of entity.points) {
    const x = (point.x - base.x) * scaleX, y = (point.y - base.y) * scaleY;
    point.x = origin.x + cos * x - sin * y;
    point.y = origin.y + sin * x + cos * y
  }
  entity.radius = entity.radius ? entity.radius * (Math.abs(scaleX) + Math.abs(scaleY)) / 2 : entity.radius;
  entity.height = entity.height ? entity.height * (Math.abs(scaleX) + Math.abs(scaleY)) / 2 : entity.height;
  entity.rotation = (entity.rotation || 0) + (insert.rotation || 0);
  if (entity.startAngle != null) entity.startAngle += insert.rotation || 0;
  if (entity.endAngle != null) entity.endAngle += insert.rotation || 0;
  entity.scaleX = (entity.scaleX ?? 1) * scaleX;
  entity.scaleY = (entity.scaleY ?? 1) * scaleY;
  if (entity.layer === "0") entity.layer = insert.layer;
  entity.fromBlock = insert.block;
  return entity
}

function expandBlockEntities(entities, blocks, options = {}) {
  // 중첩 블록은 재귀가 아니라 명시적 스택으로 반복 순회해 브라우저 호출 스택 초과를 막는다.
  // ancestry로 순환 참조를 차단하고 maxEntities로 비정상 배열 블록의 메모리 폭증을 막는다.
  const maxDepth = options.maxDepth ?? 32;
  const maxEntities = options.maxEntities ?? 1000000;
  const expanded = [];
  const stack = [];
  let circularReferences = 0;
  let omittedEntities = 0;
  for (let index = entities.length - 1; index >= 0; index--) {
    stack.push({entity: entities[index], depth: 0, ancestry: new Set()})
  }
  while (stack.length && expanded.length < maxEntities) {
    const item = stack.pop();
    expanded.push(item.entity);
    if (item.entity.type !== "INSERT" || !blocks.has(item.entity.block)) continue;
    if (item.depth >= maxDepth || item.ancestry.has(item.entity.block)) {
      circularReferences++;
      continue
    }
    const definition = blocks.get(item.entity.block);
    const ancestry = new Set(item.ancestry);
    ancestry.add(item.entity.block);
    for (let index = definition.entities.length - 1; index >= 0; index--) {
      stack.push({
        entity: transformBlockEntity(definition.entities[index], item.entity, definition.base),
        depth: item.depth + 1,
        ancestry
      })
    }
  }
  if (stack.length) omittedEntities = stack.length;
  return {entities: expanded, truncated: stack.length > 0, omittedEntities, circularReferences, maxEntities}
}

export function parseDxf(text, name = "drawing.dxf", expandBlocks = true) {
  const p = pairs(text),
    entities = [];
  let inEntities = false,
    current = null;
  const finish = () => {
    if (current && ["LINE", "CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "TEXT", "MTEXT", "INSERT", "POINT", "DIMENSION"].includes(current.type)) {
      normalize(current);
      entities.push(current)
    }
    current = null
  };
  for (const [code, value] of p) {
    if (code === "0" && value === "SECTION") continue;
    if (code === "2" && value === "ENTITIES") {
      inEntities = true;
      continue
    }
    if (inEntities && code === "0" && value === "ENDSEC") {
      finish();
      inEntities = false;
      continue
    }
    if (!inEntities) continue;
    if (code === "0") {
      finish();
      current = {
        type: value,
        layer: "0",
        points: [],
        _x: []
      };
      continue
    }
    if (!current) continue;
    if (code === "8") current.layer = value;
    else if (code === "10") current._x.push(num(value));
    else if (code === "20") {
      const x = current._x[current.points.length] ?? current._x.at(-1) ?? 0;
      current.points.push({
        x,
        y: num(value)
      })
    } else if (code === "11") current.x2 = num(value);
    else if (code === "21") current.y2 = num(value);
    else if (code === "13") current.x3 = num(value);
    else if (code === "23") current.y3 = num(value);
    else if (code === "14") current.x4 = num(value);
    else if (code === "24") current.y4 = num(value);
    else if (code === "40") {
      if (["CIRCLE", "ARC"].includes(current.type)) current.radius = num(value);
      else current.height = num(value)
    } else if (code === "41" && current.type === "INSERT") current.scaleX = num(value);
    else if (code === "42" && current.type === "INSERT") current.scaleY = num(value);
    else if (code === "42" && current.points.length) current.points.at(-1).bulge = num(value);
    else if (code === "50") {
      if (current.type === "ARC") current.startAngle = num(value);
      else current.rotation = num(value)
    }
    else if (code === "51") current.endAngle = num(value);
    else if (code === "70") current.flags = num(value);
    else if (code === "1" || code === "3") current.text = (current.text || "") + value;
    else if (code === "2") current.block = value;
  }
  finish();
  const blocks = expandBlocks ? parseBlockDefinitions(p) : new Map(), expansion = expandBlocks ? expandBlockEntities(entities, blocks) : {entities, truncated: false, omittedEntities: 0, circularReferences: 0, maxEntities: 1000000},
    finalEntities = expansion.entities,
    bounds = getBounds(finalEntities);
  return {
    name,
    entities: finalEntities,
    bounds,
    blockCount: blocks.size,
    truncated: expansion.truncated,
    omittedEntities: expansion.omittedEntities,
    circularReferences: expansion.circularReferences,
    entityLimit: expansion.maxEntities
  };
}

// -----------------------------------------------------------------------------
// 도면 정렬과 변경점 비교
// 두 도면의 좌표 원점이 다를 수 있으므로 비교 전에 공통 앵커로 이동/축척을 추정한다.
// 이후 형상 서명으로 빠르게 동일 객체를 제거하고 남은 후보만 거리 기반으로 대응한다.
// -----------------------------------------------------------------------------
function normalize(e) {
  if (e.type === "LINE" && e.points[0]) e.points.push({
    x: e.x2 ?? e.points[0].x,
    y: e.y2 ?? e.points[0].y
  });
  if (e.type === "DIMENSION") {
    for (const point of [{x: e.x2, y: e.y2}, {x: e.x3, y: e.y3}, {x: e.x4, y: e.y4}]) {
      if (Number.isFinite(point.x) && Number.isFinite(point.y)) e.points.push(point)
    }
  }
  e.closed = Boolean((e.flags || 0) & 1);
  if (typeof e.text === "string") e.text = cleanCadText(e.text);
  e.layer = cleanCadText(e.layer) || "0";
  if (typeof e.block === "string") e.block = cleanCadText(e.block);
  delete e._x
}

export function entityCenter(e) {
  if (!e.points.length) return {
    x: 0,
    y: 0
  };
  if (e.type === "CIRCLE" || e.type === "ARC") return e.points[0];
  return {
    x: e.points.reduce((s, p) => s + p.x, 0) / e.points.length,
    y: e.points.reduce((s, p) => s + p.y, 0) / e.points.length
  }
}

function entityBounds(e) {
  const pts = e.points.length ? e.points : [{
    x: 0,
    y: 0
  }];
  let xs = pts.map(p => p.x),
    ys = pts.map(p => p.y);
  if (e.radius) {
    xs = [pts[0].x - e.radius, pts[0].x + e.radius];
    ys = [pts[0].y - e.radius, pts[0].y + e.radius]
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const x of xs) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x
  }
  for (const y of ys) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y
  }
  return {minX, minY, maxX, maxY}
}

export function getBounds(es) {
  if (!es.length) return {
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const entity of es) {
    const bounds = entityBounds(entity);
    if (bounds.minX < minX) minX = bounds.minX;
    if (bounds.minY < minY) minY = bounds.minY;
    if (bounds.maxX > maxX) maxX = bounds.maxX;
    if (bounds.maxY > maxY) maxY = bounds.maxY
  }
  return {minX, minY, maxX, maxY}
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function signature(e) {
  // 좌표를 제외한 1차 해시다. 완전히 동일한 객체를 빠르게 묶되 실제 변경 판단은
  // shapeSignature와 거리 검사를 추가로 거쳐 해시 충돌이나 근접 객체 오판을 줄인다.
  const r = n => Math.round((n || 0) * 100) / 100;
  return JSON.stringify({
    t: e.type,
    l: e.layer,
    p: e.points.map(p => [r(p.x), r(p.y)]),
    r: r(e.radius),
    s: r(e.startAngle),
    a: r(e.endAngle),
    x: e.text || "",
    b: e.block || "",
    h: r(e.height),
    o: r(e.rotation),
    c: e.closed,
    u: e.points.map(point => r(point.bulge))
  })
}

export function cloneDrawing(d) {
  const entities = d.entities.map(e => ({
    ...e,
    points: e.points.map(p => ({
      ...p
    }))
  }));
  return {
    ...d,
    entities,
    bounds: getBounds(entities)
  }
}

function shapeSignature(e) {
  const c = entityCenter(e),
    r = n => Math.round((n || 0) * 100) / 100;
  return JSON.stringify({
    t: e.type,
    l: e.layer,
    p: e.points.map(p => [r(p.x - c.x), r(p.y - c.y)]),
    r: r(e.radius),
    s: r(e.startAngle),
    a: r(e.endAngle),
    x: e.text || "",
    b: e.block || ""
  })
}

function alignmentAnchorKey(entity) {
  if (["TEXT", "MTEXT"].includes(entity.type) && entity.text?.trim()) {
    return `TEXT:${entity.layer}:${entity.text.trim().replace(/\s+/g," ").toUpperCase()}`
  }
  if (entity.type === "INSERT" && entity.block) return `BLOCK:${entity.layer}:${entity.block.toUpperCase()}`;
  return null
}

function uniqueAnchors(drawing) {
  const grouped = new Map();
  for (const entity of drawing.entities) {
    const key = alignmentAnchorKey(entity);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entityCenter(entity))
  }
  return new Map([...grouped].filter(([, points]) => points.length === 1).map(([key, points]) => [key, points[0]]))
}

function estimateSimilarity(oldD, newD) {
  const oldAnchors = uniqueAnchors(oldD), newAnchors = uniqueAnchors(newD),
    allPairs = [...oldAnchors].filter(([key]) => newAnchors.has(key)).map(([key, oldPoint]) => ({key, oldPoint, newPoint: newAnchors.get(key)})),
    stride = Math.max(1, Math.ceil(allPairs.length / 160)),
    pairs = allPairs.filter((_, index) => index % stride === 0).slice(0, 160);
  if (pairs.length < 2) return null;
  const span = Math.max(oldD.bounds.maxX - oldD.bounds.minX, oldD.bounds.maxY - oldD.bounds.minY, 1);
  let best = null;
  for (let first = 0; first < pairs.length - 1; first++) {
    for (let second = first + 1; second < pairs.length; second++) {
      const a = pairs[first], b = pairs[second], oldDistance = distance(a.oldPoint, b.oldPoint), newDistance = distance(a.newPoint, b.newPoint);
      if (oldDistance < span * .03 || newDistance < .001) continue;
      const scale = oldDistance / newDistance;
      if (scale < .1 || scale > 10) continue;
      const angle = Math.atan2(b.oldPoint.y - a.oldPoint.y, b.oldPoint.x - a.oldPoint.x) - Math.atan2(b.newPoint.y - a.newPoint.y, b.newPoint.x - a.newPoint.x),
        cos = Math.cos(angle), sin = Math.sin(angle), tx = a.oldPoint.x - scale * (cos * a.newPoint.x - sin * a.newPoint.y), ty = a.oldPoint.y - scale * (sin * a.newPoint.x + cos * a.newPoint.y);
      let votes = 0, error = 0;
      for (const pair of pairs) {
        const transformed = {x: scale * (cos * pair.newPoint.x - sin * pair.newPoint.y) + tx, y: scale * (sin * pair.newPoint.x + cos * pair.newPoint.y) + ty}, residual = distance(transformed, pair.oldPoint);
        if (residual <= span * .008) votes++;
        error += Math.min(residual, span) / span
      }
      const candidate = {mode: "similarity", scale, angle, dx: tx, dy: ty, votes, confidence: votes / pairs.length, error: error / pairs.length, applied: votes >= 2};
      if (!best || candidate.votes > best.votes || (candidate.votes === best.votes && candidate.error < best.error)) best = candidate
    }
  }
  return best?.confidence >= .55 ? best : null
}

export function estimateAlignment(oldD, newD) {
  // 문자/블록 등 안정적인 앵커 후보의 좌표 차이를 표본화하고 다수결에 가까운
  // 변환을 선택한다. 앵커가 부족하면 안전하게 무정렬 상태로 되돌아간다.
  const similarity = estimateSimilarity(oldD, newD);
  if (similarity) return similarity;
  const span = Math.max(oldD.bounds.maxX - oldD.bounds.minX, oldD.bounds.maxY - oldD.bounds.minY, 1),
    step = Math.max(span * .002, .01),
    bins = new Map(), oldGroups = new Map(), newGroups = new Map(), sampleLimit = 32;
  for (const [drawing, groups] of [[oldD, oldGroups], [newD, newGroups]]) {
    for (const entity of drawing.entities) {
      const key = shapeSignature(entity);
      if (!groups.has(key)) groups.set(key, []);
      const group = groups.get(key);
      if (group.length < sampleLimit) group.push(entityCenter(entity))
    }
  }
  for (const [key, oldCenters] of oldGroups) {
    const newCenters = newGroups.get(key);
    if (!newCenters) continue;
    for (const oc of oldCenters) {
      for (const nc of newCenters) {
        const dx = oc.x - nc.x,
        dy = oc.y - nc.y,
        k = `${Math.round(dx/step)},${Math.round(dy/step)}`,
        v = bins.get(k) || {
          dx: 0,
          dy: 0,
          votes: 0
        };
      v.dx += dx;
      v.dy += dy;
      v.votes++;
      bins.set(k, v)
      }
    }
  }
  const best = [...bins.values()].sort((a, b) => b.votes - a.votes)[0];
  if (!best) return {
    dx: 0,
    dy: 0,
    votes: 0,
    confidence: 0,
    applied: false
  };
  const candidates = Math.max(1, Math.min(oldD.entities.length, newD.entities.length)),
    confidence = Math.min(1, best.votes / candidates * 2);
  return {
    mode: "translation",
    dx: best.dx / best.votes,
    dy: best.dy / best.votes,
    votes: best.votes,
    confidence,
    applied: best.votes >= 2 || confidence >= .35
  };
}

export function translateDrawing(d, dx, dy) {
  for (const e of d.entities)
    for (const p of e.points) {
      p.x += dx;
      p.y += dy
    }
  d.bounds = getBounds(d.entities);
  return d
}

export function compare(oldD, newD) {
  // 결과는 added/removed/changed 세 종류로 통일한다. UI와 CSV가 동일한 결과 배열을
  // 소비하므로 비교 규칙을 변경할 때는 이 함수의 출력 계약을 유지해야 한다.
  const diffs = [], used = new Uint8Array(newD.entities.length), exactBuckets = new Map(), spatial = new Map(),
    span = Math.max(oldD.bounds.maxX - oldD.bounds.minX, oldD.bounds.maxY - oldD.bounds.minY, 1), cellSize = Math.max(span / 200, .000001);
  const spatialKey = (entity, center) => `${entity.type}:${Math.floor(center.x / cellSize)}:${Math.floor(center.y / cellSize)}`;
  for (let index = 0; index < newD.entities.length; index++) {
    const entity = newD.entities[index], exactKey = signature(entity), center = entityCenter(entity);
    if (!exactBuckets.has(exactKey)) exactBuckets.set(exactKey, []);
    exactBuckets.get(exactKey).push(index);
    const key = spatialKey(entity, center);
    if (!spatial.has(key)) spatial.set(key, []);
    spatial.get(key).push(index)
  }
  oldD.entities.forEach((o, oi) => {
    let exact = -1;
    const bucket = exactBuckets.get(signature(o));
    while (bucket?.length && exact < 0) {
      const candidate = bucket.pop();
      if (!used[candidate]) exact = candidate
    }
    if (exact >= 0) {
      used[exact] = 1;
      return
    }
    const oc = entityCenter(o), gridX = Math.floor(oc.x / cellSize), gridY = Math.floor(oc.y / cellSize);
    let best = -1, score = Infinity;
    for (let radius = 1; radius <= 4 && best < 0; radius++) {
      for (let offsetX = -radius; offsetX <= radius; offsetX++) {
        for (let offsetY = -radius; offsetY <= radius; offsetY++) {
          if (radius > 1 && Math.abs(offsetX) < radius && Math.abs(offsetY) < radius) continue;
          for (const ni of spatial.get(`${o.type}:${gridX + offsetX}:${gridY + offsetY}`) || []) {
            if (used[ni]) continue;
            const n = newD.entities[ni];
            const candidateScore = distance(oc, entityCenter(n)) / span + (n.layer === o.layer ? 0 : .04) + ((n.text || "") === (o.text || "") ? 0 : .06);
            if (candidateScore < score) {
              score = candidateScore;
              best = ni
            }
          }
        }
      }
    }
    if (best >= 0 && score < .12) {
      used[best] = 1;
      diffs.push({
        kind: "changed",
        oldIndex: oi,
        newIndex: best,
        type: o.type,
        layer: o.layer,
        center: entityCenter(newD.entities[best]),
        detail: describeChange(o, newD.entities[best])
      })
    } else diffs.push({
      kind: "removed",
      oldIndex: oi,
      type: o.type,
      layer: o.layer,
      center: oc,
      detail: `${o.layer} 레이어의 ${labelType(o.type)} 삭제`
    });
  });
  for (let ni = 0; ni < newD.entities.length; ni++) {
    if (used[ni]) continue;
    const n = newD.entities[ni];
    diffs.push({
      kind: "added",
      newIndex: ni,
      type: n.type,
      layer: n.layer,
      center: entityCenter(n),
      detail: `${n.layer} 레이어에 ${labelType(n.type)} 추가`
    })
  }
  return diffs;
}

function describeChange(a, b) {
  if ((a.text || "") !== (b.text || "")) return `문자 “${a.text||"-"}” → “${b.text||"-"}”`;
  const ca = entityCenter(a),
    cb = entityCenter(b),
    move = distance(ca, cb);
  if (move > .01) return `${labelType(a.type)} 위치 이동 (${move.toFixed(2)})`;
  if ((a.radius || 0) !== (b.radius || 0)) return `반지름 ${a.radius||0} → ${b.radius||0}`;
  return `${labelType(a.type)} 형상 또는 속성 변경`
}

export function labelType(t) {
  return ({
    LINE: "선",
    CIRCLE: "원",
    ARC: "호",
    LWPOLYLINE: "폴리라인",
    POLYLINE: "폴리라인",
    TEXT: "문자",
    MTEXT: "여러 줄 문자",
    INSERT: "블록",
    POINT: "점",
    DIMENSION: "치수",
    PDF: "PDF 영역"
  })[t] || t
}
