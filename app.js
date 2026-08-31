import { fitCadViews, focusCadViews, renderCadFile, setCadViewAlignment, setCadViewSync } from "./cad-renderer.js";
import { decodeDxfFile } from "./dxf-encoding.js";

"use strict";

const state = {
  old: null,
  new: null,
  rawNew: null,
  files: {
    old: null,
    new: null
  },
  mode: "dxf",
  pdf: null,
  page: 1,
  documents: [],
  diffs: [],
  alignment: null,
  filter: "all",
  view: {
    x: 0,
    y: 0,
    w: 100,
    h: 100
  },
  drag: null
};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const RESULT_RENDER_LIMIT = 2000;

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

function parseDxf(text, name = "drawing.dxf", expandBlocks = true) {
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
  delete e._x
}

function entityCenter(e) {
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

function getBounds(es) {
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

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function signature(e) {
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

function cloneDrawing(d) {
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

function estimateAlignment(oldD, newD) {
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

function translateDrawing(d, dx, dy) {
  for (const e of d.entities)
    for (const p of e.points) {
      p.x += dx;
      p.y += dy
    }
  d.bounds = getBounds(d.entities);
  return d
}

function compare(oldD, newD) {
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

function labelType(t) {
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

function renderDrawing(which) {
  const drawing = state[which],
    host = $(which === "old" ? "#oldViewer" : "#newViewer");
  if (!drawing) return;
  if (state.files[which]) {
    renderCadFile(which, state.files[which]);
    return
  }
  host.innerHTML = `<svg data-side="${which}" preserveAspectRatio="xMidYMid meet"><g></g></svg>`;
  const g = host.querySelector("g");
  drawing.entities.forEach((e, i) => g.insertAdjacentHTML("beforeend", entitySvg(e, i, which)));
  applyView();
  bindPan(host)
}

function renderOverlay() {
  const host = $("#overlayViewer");
  if (!state.old || !state.new) return;
  host.innerHTML = '<svg data-side="overlay" preserveAspectRatio="xMidYMid meet"><g class="old-layer"></g><g class="new-layer"></g></svg>';
  const oldG = host.querySelector(".old-layer"),
    newG = host.querySelector(".new-layer");
  state.old.entities.forEach((e, i) => oldG.insertAdjacentHTML("beforeend", entitySvg(e, i, "old").replace('class="entity', 'class="entity overlay-old')));
  state.new.entities.forEach((e, i) => newG.insertAdjacentHTML("beforeend", entitySvg(e, i, "new").replace('class="entity', 'class="entity overlay-new')));
  newG.style.opacity = $("#opacityRange").value / 100;
  applyView();
  bindPan(host)
}

function arcPath(entity) {
  const center = entity.points[0] || {x: 0, y: 0}, radius = entity.radius || 1,
    start = (entity.startAngle || 0) * Math.PI / 180, end = (entity.endAngle || 0) * Math.PI / 180,
    delta = ((entity.endAngle || 0) - (entity.startAngle || 0) + 360) % 360,
    x1 = center.x + radius * Math.cos(start), y1 = -(center.y + radius * Math.sin(start)),
    x2 = center.x + radius * Math.cos(end), y2 = -(center.y + radius * Math.sin(end));
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${delta > 180 ? 1 : 0} 0 ${x2} ${y2}`
}

function polylinePath(entity) {
  if (!entity.points.length) return "";
  const points = entity.closed ? [...entity.points, entity.points[0]] : entity.points;
  let path = `M ${points[0].x} ${-points[0].y}`;
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index], end = points[index + 1], bulge = start.bulge || 0;
    if (Math.abs(bulge) < 1e-9) path += ` L ${end.x} ${-end.y}`;
    else {
      const chord = Math.hypot(end.x - start.x, end.y - start.y), radius = chord * (1 + bulge * bulge) / (4 * Math.abs(bulge)), angle = 4 * Math.atan(Math.abs(bulge));
      path += ` A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} ${bulge > 0 ? 0 : 1} ${end.x} ${-end.y}`
    }
  }
  return path
}

function dimensionSvg(entity, attributes) {
  const points = entity.points;
  if (points.length < 3) return `<circle ${attributes} cx="${points[0]?.x||0}" cy="${-(points[0]?.y||0)}" r="1.5"/>`;
  const definition = points[0], first = points.at(-2), second = points.at(-1), size = Math.max(distance(first, second) * .025, 1);
  return `<g ${attributes}><line x1="${first.x}" y1="${-first.y}" x2="${second.x}" y2="${-second.y}"/><line x1="${first.x}" y1="${-first.y}" x2="${definition.x}" y2="${-definition.y}"/><line x1="${second.x}" y1="${-second.y}" x2="${definition.x}" y2="${-definition.y}"/><circle cx="${first.x}" cy="${-first.y}" r="${size}"/><circle cx="${second.x}" cy="${-second.y}" r="${size}"/></g>`
}

function entitySvg(e, i, side) {
  const cls = ["entity", ["TEXT", "MTEXT"].includes(e.type) ? "text" : ""];
  const d = state.diffs.find(x => (side === "old" ? x.oldIndex : x.newIndex) === i);
  if (d) cls.push(`diff-${d.kind}`);
  const a = `class="${cls.join(" ")}" data-index="${i}"`;
  if (e.type === "LINE") return `<line ${a} x1="${e.points[0]?.x||0}" y1="${-(e.points[0]?.y||0)}" x2="${e.points[1]?.x||0}" y2="${-(e.points[1]?.y||0)}"/>`;
  if (e.type === "CIRCLE") return `<circle ${a} cx="${e.points[0]?.x||0}" cy="${-(e.points[0]?.y||0)}" r="${e.radius||1}"/>`;
  if (e.type === "ARC") return `<path ${a} d="${arcPath(e)}"/>`;
  if (e.type === "TEXT" || e.type === "MTEXT") return `<text ${a} x="${e.points[0]?.x||0}" y="${-(e.points[0]?.y||0)}" font-size="${e.height||3}" transform="rotate(${-(e.rotation||0)} ${e.points[0]?.x||0} ${-(e.points[0]?.y||0)})">${escapeHtml(e.text||"")}</text>`;
  if (e.type === "DIMENSION") return dimensionSvg(e, a);
  if (e.type === "POINT" || e.type === "INSERT") return `<circle ${a} cx="${e.points[0]?.x||0}" cy="${-(e.points[0]?.y||0)}" r="1.4"/>`;
  return `<path ${a} d="${polylinePath(e)}"/>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c])
}

function fit() {
  if (state.mode !== "pdf" && (state.files.old || state.files.new)) fitCadViews();
  if (state.mode === "pdf" && state.pdf) {
    const page = state.pdf.pages[state.page - 1];
    state.view = {
      x: 0,
      y: 0,
      w: page.width,
      h: page.height
    };
    applyView();
    return
  }
  if (!state.old && !state.new) return;
  const all = [...(state.old?.entities || []), ...(state.new?.entities || [])],
    b = getBounds(all),
    pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * .08 || 5;
  state.view = {
    x: b.minX - pad,
    y: -b.maxY - pad,
    w: b.maxX - b.minX + pad * 2,
    h: b.maxY - b.minY + pad * 2
  };
  applyView()
}

function applyView() {
  for (const svg of $$(".viewer svg")) svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`)
}

function bindPan(host) {
  host.onwheel = e => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.12 : .89,
      cx = state.view.x + state.view.w / 2,
      cy = state.view.y + state.view.h / 2;
    state.view.w *= f;
    state.view.h *= f;
    state.view.x = cx - state.view.w / 2;
    state.view.y = cy - state.view.h / 2;
    applyView()
  };
  host.onpointerdown = e => {
    host.setPointerCapture(e.pointerId);
    state.drag = {
      x: e.clientX,
      y: e.clientY,
      v: {
        ...state.view
      }
    }
  };
  host.onpointermove = e => {
    if (!state.drag) return;
    state.view.x = state.drag.v.x - (e.clientX - state.drag.x) / host.clientWidth * state.drag.v.w;
    state.view.y = state.drag.v.y - (e.clientY - state.drag.y) / host.clientHeight * state.drag.v.h;
    applyView()
  };
  host.onpointerup = () => state.drag = null
}

function renderResults() {
  const count = k => state.diffs.filter(d => d.kind === k).length;
  $("#summary").textContent = `총 ${state.diffs.length}건 · 변경 ${count("changed")} · 추가 ${count("added")} · 삭제 ${count("removed")}`;
  for (const b of $$(".filters button")) {
    const k = b.dataset.filter;
    b.querySelector("span").textContent = k === "all" ? state.diffs.length : count(k)
  }
  const matchingRows = state.diffs.map((diff, index) => ({diff, index})).filter(({diff}) => state.filter === "all" || diff.kind === state.filter);
  const rows = matchingRows.slice(0, RESULT_RENDER_LIMIT);
  const limitedNotice = matchingRows.length > RESULT_RENDER_LIMIT ? `<div class="empty-row">화면 성능을 위해 ${matchingRows.length.toLocaleString("ko-KR")}건 중 ${RESULT_RENDER_LIMIT.toLocaleString("ko-KR")}건만 표시합니다. CSV에는 전체 결과가 포함됩니다.</div>` : "";
  $("#resultList").innerHTML = rows.length ? rows.map(({diff: d, index}) => {
    const location = state.mode === "pdf" ? `${d.page}페이지` : `X ${d.center.x.toFixed(2)} · Y ${d.center.y.toFixed(2)}`;
    return `<div class="result-row" data-id="${index}"><span class="badge ${d.kind}">${({added:"추가",removed:"삭제",changed:"변경"})[d.kind]}</span><span class="entity-type">${labelType(d.type)}</span><span>${escapeHtml(d.detail)}</span><span class="location">${location}</span></div>`
  }).join("") + limitedNotice : `<div class="empty-row">해당 항목이 없습니다.</div>`;
  for (const row of $$(".result-row")) row.onclick = () => focusDiff(state.diffs[+row.dataset.id])
}

function focusDiff(d) {
  if (state.mode === "pdf") {
    if (state.page !== d.page) {
      state.page = d.page;
      $("#pageSelect").value = String(d.page);
      renderPdfPage()
    }
    const box = d.box;
    state.view = {
      x: Math.max(0, box.x - box.w * .35),
      y: Math.max(0, box.y - box.h * .35),
      w: Math.max(80, box.w * 1.7),
      h: Math.max(80, box.h * 1.7)
    };
    applyView();
    $$('.pdf-change-box.focused').forEach(e => e.classList.remove('focused'));
    $$(`[data-change-id="${d.id}"]`).forEach(e => e.classList.add("focused"));
    return
  }
  const size = Math.max(state.view.w, state.view.h) * .2;
  const oldCenter = d.oldIndex != null ? entityCenter(state.old.entities[d.oldIndex]) : d.center;
  const newCenter = d.newIndex != null ? entityCenter(state.rawNew.entities[d.newIndex]) : inverseAlignmentPoint(d.center, state.alignment);
  focusCadViews({old: oldCenter, new: newCenter});
  state.view = {
    x: d.center.x - size / 2,
    y: -d.center.y - size / 2,
    w: size,
    h: size
  };
  applyView();
  $$('.entity.focused').forEach(e => e.classList.remove('focused'));
  if (d.oldIndex != null) $(`#oldViewer [data-index="${d.oldIndex}"]`)?.classList.add("focused");
  if (d.newIndex != null) $(`#newViewer [data-index="${d.newIndex}"]`)?.classList.add("focused")
}

function inverseAlignmentPoint(point, alignment) {
  if (!alignment?.applied || !$("#alignToggle").checked) return point;
  if (alignment.mode !== "similarity") return {x: point.x - alignment.dx, y: point.y - alignment.dy};
  const scale = alignment.scale || 1, cos = Math.cos(alignment.angle), sin = Math.sin(alignment.angle),
    x = (point.x - alignment.dx) / scale, y = (point.y - alignment.dy) / scale;
  return {x: cos * x + sin * y, y: -sin * x + cos * y}
}
async function loadFile(input, side) {
  const f = input.files[0];
  if (!f) return;
  const dropzone = $(`#${side}Drop`);
  dropzone.classList.remove("error");
  const isPdf = f.name.toLowerCase().endsWith(".pdf");
  const isDwg = f.name.toLowerCase().endsWith(".dwg");
  const other = state.files[side === "old" ? "new" : "old"];
  const format = isPdf ? "pdf" : isDwg ? "dwg" : "dxf";
  const otherFormat = other ? other.name.toLowerCase().endsWith(".pdf") ? "pdf" : other.name.toLowerCase().endsWith(".dwg") ? "dwg" : "dxf" : null;
  if (otherFormat && otherFormat !== format) {
    $("#status").textContent = "비교할 두 파일은 같은 형식이어야 합니다.";
    return
  }
  state.mode = format;
  setCadViewAlignment(null);
  $(`#${side}Name`).textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(2)}MB`;
  if (isPdf) {
    state.files[side] = f;
    $("#status").textContent = "PDF 두 파일을 선택한 뒤 도면 비교를 누르세요.";
    return
  }
  if (isDwg) {
    state.files[side] = f;
    if (side === "new") {
      state.rawNew = null;
      state.new = null
    } else state.old = null;
    renderCadFile(side, f);
    $(`#${side}Name`).textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(2)}MB · LibreDWG`;
    $("#status").textContent = "DWG를 브라우저에서 렌더링하고 있습니다. 현재 DWG는 화면 확인을 지원하며 변경 목록 계산은 DXF를 사용합니다.";
    return
  }
  $("#pageControl").hidden = true;
  $("#overlayBtn").disabled = false;
  $("#alignToggle").disabled = false;
  try {
    const decoded = await decodeDxfFile(f), text = decoded.text;
    if (text.startsWith("AutoCAD Binary DXF")) throw new Error("바이너리 DXF는 아직 지원하지 않습니다. ASCII DXF로 저장하세요.");
    if (!/\bSECTION\b[\s\S]*\bENTITIES\b/.test(text)) throw new Error("DXF의 ENTITIES 섹션을 찾지 못했습니다.");
    const drawing = parseDxf(text, f.name, true);
    if (!drawing.entities.length) throw new Error("표시할 수 있는 DXF 객체를 찾지 못했습니다. 지원 객체 또는 파일 형식을 확인하세요.");
    state.files[side] = f;
    if (side === "new") {
      state.rawNew = drawing;
      state.new = cloneDrawing(drawing)
    } else state.old = drawing;
    const blockWarning = drawing.truncated ? ` · 분석 한도 ${drawing.entityLimit.toLocaleString("ko-KR")}개` : drawing.circularReferences ? ` · 순환 블록 ${drawing.circularReferences}건 제외` : "";
    $(`#${side}Name`).textContent = `${f.name} · ${drawing.entities.length.toLocaleString("ko-KR")}개 객체 · 블록 ${drawing.blockCount || 0}개 · ${decoded.codepage}${blockWarning}`;
    renderDrawing(side);
    fit();
    $("#status").textContent = drawing.truncated ? `${side === "old" ? "원본" : "변경본"}은 분석 객체 한도에 도달했습니다. 화면 렌더링은 전체 도면을 유지합니다.` : `${side === "old" ? "원본" : "변경본"} 도면을 정상적으로 인식했습니다.`
  } catch (error) {
    state.files[side] = null;
    if (side === "new") {
      state.rawNew = null;
      state.new = null
    } else state.old = null;
    dropzone.classList.add("error");
    $(`#${side}Name`).textContent = `${f.name} · 인식 실패`;
    $("#status").textContent = `${side === "old" ? "원본" : "변경본"}: ${error.message}`
  }
}

async function runCompare() {
  if (state.mode === "pdf") {
    await runPdfCompare();
    return
  }
  if (!state.old || !state.rawNew) {
    $("#status").textContent = "변경 목록을 계산하려면 원본과 변경본 DXF를 모두 선택하세요.";
    return
  }
  $("#compareBtn").disabled = true;
  $("#status").textContent = "대용량 안전 모드로 정렬 및 변경 항목을 계산하고 있습니다…";
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
  try {
    state.new = cloneDrawing(state.rawNew);
    state.alignment = estimateAlignment(state.old, state.new);
    if ($("#alignToggle").checked && state.alignment.applied) transformDrawing(state.new, state.alignment);
    setCadViewAlignment($("#alignToggle").checked ? state.alignment : null);
    state.diffs = compare(state.old, state.new);
    renderDrawing("old");
    renderDrawing("new");
    if (!$("#overlayPanel").hidden) renderOverlay();
    fit();
    renderResults();
    $("#exportBtn").disabled = false;
    const a = state.alignment,
      alignText = $("#alignToggle").checked && a.applied ? (a.mode === "similarity" ? ` · 자동 정렬 회전 ${(a.angle*180/Math.PI).toFixed(2)}°, 축척 ${a.scale.toFixed(4)} (${a.votes}개 앵커)` : ` · 자동 정렬 ΔX ${a.dx.toFixed(2)}, ΔY ${a.dy.toFixed(2)} (${a.votes}개 기준 객체)`) : " · 자동 정렬 없음";
    $("#status").textContent = `비교 완료: ${state.old.entities.length.toLocaleString("ko-KR")}개 ↔ ${state.new.entities.length.toLocaleString("ko-KR")}개 객체${alignText}`
  } catch (error) {
    $("#status").textContent = `도면 비교 실패: ${error.message}`
  } finally {
    $("#compareBtn").disabled = false
  }
}

function transformDrawing(drawing, alignment) {
  if (alignment.mode !== "similarity") return translateDrawing(drawing, alignment.dx, alignment.dy);
  const cos = Math.cos(alignment.angle), sin = Math.sin(alignment.angle);
  for (const entity of drawing.entities) {
    for (const point of entity.points) {
      const x = point.x, y = point.y;
      point.x = alignment.scale * (cos * x - sin * y) + alignment.dx;
      point.y = alignment.scale * (sin * x + cos * y) + alignment.dy
    }
    if (entity.radius) entity.radius *= alignment.scale;
    if (entity.height) entity.height *= alignment.scale;
    if (entity.rotation != null || ["TEXT", "MTEXT", "INSERT"].includes(entity.type)) {
      entity.rotation = (entity.rotation || 0) + alignment.angle * 180 / Math.PI
    }
    if (entity.startAngle != null) entity.startAngle += alignment.angle * 180 / Math.PI;
    if (entity.endAngle != null) entity.endAngle += alignment.angle * 180 / Math.PI
  }
  drawing.bounds = getBounds(drawing.entities);
  return drawing
}

async function runPdfCompare() {
  if (!state.files.old || !state.files.new) {
    $("#status").textContent = "원본과 변경본 PDF를 모두 선택하세요.";
    return
  }
  $("#compareBtn").disabled = true;
  $("#status").textContent = "PDF 페이지를 렌더링하고 변경 영역을 분석하고 있습니다…";
  try {
    const form = new FormData();
    form.append("old", state.files.old);
    form.append("new", state.files.new);
    const response = await fetch("/api/pdf/compare", {
      method: "POST",
      body: form
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "PDF 비교에 실패했습니다.");
    state.pdf = result;
    state.page = 1;
    state.diffs = result.changes.map(change => ({
      ...change,
      type: "PDF",
      layer: `${change.page}페이지`,
      center: {
        x: change.box.x + change.box.w / 2,
        y: change.box.y + change.box.h / 2
      }
    }));
    const select = $("#pageSelect");
    select.innerHTML = result.pages.map(page => `<option value="${page.number}">${page.number} / ${result.pageCount}</option>`).join("");
    $("#pageControl").hidden = false;
    $("#overlayBtn").disabled = true;
    $("#alignToggle").disabled = true;
    $("#exportBtn").disabled = false;
    renderPdfPage();
    renderResults();
    $("#status").textContent = `PDF 비교 완료: ${result.pageCount}페이지 · 변경 영역 ${state.diffs.length}건`;
  } catch (error) {
    $("#status").textContent = error.message
  } finally {
    $("#compareBtn").disabled = false
  }
}

function renderPdfPage() {
  const page = state.pdf.pages[state.page - 1];
  for (const side of ["old", "new"]) {
    const host = $(`#${side}Viewer`);
    const image = page[`${side}Image`];
    const boxes = state.diffs
      .filter(change => change.page === state.page)
      .map(change => `<rect class="pdf-change-box" data-change-id="${change.id}" x="${change.box.x}" y="${change.box.y}" width="${change.box.w}" height="${change.box.h}"/>`)
      .join("");
    host.innerHTML = image ? `<svg data-side="${side}" viewBox="0 0 ${page.width} ${page.height}" preserveAspectRatio="xMidYMid meet"><image href="${image}" width="${page.width}" height="${page.height}"/>${boxes}</svg>` : `<div class="empty">해당 페이지 없음</div>`;
    if (image) bindPan(host)
  }
  fit()
}

function sampleDxf(changed = false) {
  const lines = changed ? [
      [0, 0, 100, 0],
      [100, 0, 100, 65],
      [100, 65, 0, 65],
      [0, 65, 0, 0],
      [20, 20, 80, 20],
      [15, 48, 35, 48],
      [65, 48, 85, 48]
    ] : [
      [0, 0, 100, 0],
      [100, 0, 100, 60],
      [100, 60, 0, 60],
      [0, 60, 0, 0],
      [20, 20, 75, 20],
      [15, 48, 35, 48],
      [65, 48, 85, 48]
    ];
  const project = (x, y) => {
    if (!changed) return {x, y};
    const scale = 1.18, angle = 8 * Math.PI / 180;
    return {x: scale * (Math.cos(angle) * x - Math.sin(angle) * y) + 240, y: scale * (Math.sin(angle) * x + Math.cos(angle) * y) - 130}
  };
  let s = "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nVALVE_SYMBOL\n10\n0\n20\n0\n0\nLINE\n8\n0\n10\n-4\n20\n0\n11\n4\n21\n0\n0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n2\n0\nTEXT\n8\n0\n10\n-3\n20\n3\n40\n2\n1\nVALVE\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n";
  for (const line of lines) {
    const start = project(line[0], line[1]), end = project(line[2], line[3]);
    s += `0\nLINE\n8\nWALL\n10\n${start.x}\n20\n${start.y}\n11\n${end.x}\n21\n${end.y}\n`
  }
  const circle = project(changed ? 55 : 50, 40), revision = project(10, 10), anchorA = project(10, 50), anchorB = project(90, 10);
  s += `0\nCIRCLE\n8\nOPENING\n10\n${circle.x}\n20\n${circle.y}\n40\n${8*(changed?1.18:1)}\n`;
  const arc = project(72, 38);
  s += `0\nARC\n8\nDETAIL\n10\n${arc.x}\n20\n${arc.y}\n40\n${10*(changed?1.18:1)}\n50\n${20+(changed?8:0)}\n51\n${155+(changed?8:0)}\n`;
  const polyline = [[30,28],[42,28],[42,38]].map(([x,y]) => project(x,y));
  s += `0\nLWPOLYLINE\n8\nDETAIL\n70\n1\n10\n${polyline[0].x}\n20\n${polyline[0].y}\n42\n0.35\n10\n${polyline[1].x}\n20\n${polyline[1].y}\n10\n${polyline[2].x}\n20\n${polyline[2].y}\n`;
  const dimension = [project(20,5),project(20,0),project(80,0)];
  s += `0\nDIMENSION\n8\nDIMENSION\n10\n${dimension[0].x}\n20\n${dimension[0].y}\n13\n${dimension[1].x}\n23\n${dimension[1].y}\n14\n${dimension[2].x}\n24\n${dimension[2].y}\n1\n60\n`;
  for (const [point, text] of [[revision, changed ? "REV B" : "REV A"], [anchorA, "GRID-A"], [anchorB, "GRID-B"]]) {
    s += `0\nTEXT\n8\nNOTE\n10\n${point.x}\n20\n${point.y}\n50\n${changed?8:0}\n1\n${text}\n`
  }
  const valve = project(60, 32);
  s += `0\nINSERT\n8\nEQUIPMENT\n2\nVALVE_SYMBOL\n10\n${valve.x}\n20\n${valve.y}\n41\n${changed?1.18:1}\n42\n${changed?1.18:1}\n50\n${changed?8:0}\n`;
  s += "0\nENDSEC\n0\nEOF\n";
  return s
}

function exportCsv() {
  const quote = v => `"${String(v??"").replaceAll('"','""')}"`,
    rows = [
      ["상태", "객체종류", "레이어", "설명", "X", "Y"], ...state.diffs.map(d => [({
        added: "추가",
        removed: "삭제",
        changed: "변경"
      })[d.kind], labelType(d.type), d.layer, d.detail, d.center.x.toFixed(3), d.center.y.toFixed(3)])
    ],
    blob = new Blob(["\ufeff" + rows.map(r => r.map(quote).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8"
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "drawing-differences.csv";
  a.click();
  URL.revokeObjectURL(url)
}

function drawingTextForReview() {
  if (state.mode === "pdf" && state.pdf) {
    return state.pdf.pages.flatMap(page => page.newText || []).join("\n")
  }
  if (state.new) {
    return state.new.entities
      .filter(entity => entity.text)
      .map(entity => entity.text)
      .join("\n")
  }
  return ""
}

async function runDocumentReview() {
  if (!state.documents.length) return;
  const drawingText = drawingTextForReview();
  if (!drawingText.trim()) {
    $("#reviewSummary").textContent = "도면에서 비교할 문자 정보를 찾지 못했습니다.";
    return
  }
  $("#reviewBtn").disabled = true;
  $("#reviewSummary").textContent = "문서 요구사항을 추출하고 도면 표기와 대조하고 있습니다…";
  try {
    const form = new FormData();
    form.append("names", JSON.stringify(state.documents.map(file => file.name)));
    form.append("drawingText", drawingText);
    state.documents.forEach((file, index) => form.append(`doc${index}`, file));
    const response = await fetch("/api/review", {
      method: "POST",
      body: form
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "문서 검토에 실패했습니다.");
    renderDocumentReview(result)
  } catch (error) {
    $("#reviewSummary").textContent = error.message
  } finally {
    $("#reviewBtn").disabled = false
  }
}

function renderDocumentReview(result) {
  const summary = result.summary;
  $("#reviewSummary").textContent = `요구사항 ${summary.total}건 · 도면 일치 ${summary.matched}건 · 검토 필요 ${summary.review}건`;
  $("#reviewList").innerHTML = result.findings.length ? result.findings.map(item => `
    <div class="review-row">
      <span class="review-status ${item.status}">${item.status === "matched" ? "도면 일치" : "검토 필요"}</span>
      <span>${escapeHtml(item.kind)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <span class="review-evidence">${escapeHtml(item.evidence)}</span>
      <span class="review-source">${escapeHtml(item.source)} · ${item.page}페이지</span>
    </div>
  `).join("") : `<div class="empty-row">추출된 규격 요구사항이 없습니다.</div>`
}

$("#oldFile").onchange = e => loadFile(e.target, "old");
$("#newFile").onchange = e => loadFile(e.target, "new");
$("#compareBtn").onclick = runCompare;
$("#fitBtn").onclick = fit;
$("#viewSyncToggle").onchange = e => setCadViewSync(e.target.checked);
$("#pageSelect").onchange = e => {
  state.page = Number(e.target.value);
  renderPdfPage()
};
$("#exportBtn").onclick = exportCsv;
$("#overlayBtn").onclick = () => {
  const p = $("#overlayPanel");
  p.hidden = !p.hidden;
  if (!p.hidden) renderOverlay()
};
$("#opacityRange").oninput = e => {
  $("#overlayViewer .new-layer")?.style.setProperty("opacity", e.target.value / 100)
};
$("#sampleBtn").onclick = () => {
  state.mode = "dxf";
  state.files = {
    old: null,
    new: null
  };
  $("#pageControl").hidden = true;
  $("#overlayBtn").disabled = false;
  $("#alignToggle").disabled = false;
  state.old = parseDxf(sampleDxf(false), "sample-original.dxf");
  state.rawNew = parseDxf(sampleDxf(true), "sample-revision-offset.dxf");
  state.new = cloneDrawing(state.rawNew);
  $("#oldName").textContent = `sample-original.dxf · ${state.old.entities.length}개 객체`;
  $("#newName").textContent = `sample-revision-offset.dxf · ${state.new.entities.length}개 객체`;
  runCompare()
};
for (const b of $$(".filters button")) b.onclick = () => {
  $$(".filters button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  state.filter = b.dataset.filter;
  renderResults()
};
for (const [drop, input] of [
    ["#oldDrop", "#oldFile"],
    ["#newDrop", "#newFile"]
  ]) {
  const d = $(drop);
  d.ondragover = e => {
    e.preventDefault();
    d.classList.add("drag")
  };
  d.ondragleave = () => d.classList.remove("drag");
  d.ondrop = e => {
    e.preventDefault();
    d.classList.remove("drag");
    const dt = new DataTransfer();
    dt.items.add(e.dataTransfer.files[0]);
    $(input).files = dt.files;
    $(input).dispatchEvent(new Event("change"))
  }
}
if (new URLSearchParams(location.search).get("sample") === "1") $("#sampleBtn").click();
