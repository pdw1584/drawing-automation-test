import { fitCadViews, focusCadViews, renderCadFile, setCadViewAlignment, setCadViewSync } from "../../shared/cad-renderer.js";
import {
  cloneDrawing,
  compare,
  entityCenter,
  estimateAlignment,
  getBounds,
  labelType,
  parseDxf,
  translateDrawing
} from "./engine.js";
import { decodeDxfFile } from "../../shared/dxf-encoding.js";
import {escapeHtml} from "../../shared/ui-utils.js";
import {entitySvg} from "./svg-renderer.js";

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

function renderDrawing(which) {
  // 실제 CAD 표현은 iframe WebGL 렌더러가 담당한다. 이 함수는 파일 전달과 현재
  // 정렬값만 관리해 비교 알고리즘이 특정 렌더링 라이브러리에 의존하지 않게 한다.
  const drawing = state[which],
    host = $(which === "old" ? "#oldViewer" : "#newViewer");
  if (!drawing) return;
  if (state.files[which]) {
    renderCadFile(which, state.files[which]);
    return
  }
  host.innerHTML = `<svg data-side="${which}" preserveAspectRatio="xMidYMid meet"><g></g></svg>`;
  const g = host.querySelector("g");
  drawing.entities.forEach((e, i) => g.insertAdjacentHTML("beforeend", entitySvg(e, i, which, state.diffs)));
  applyView();
  bindPan(host)
}

function renderOverlay() {
  const host = $("#overlayViewer");
  if (!state.old || !state.new) return;
  host.innerHTML = '<svg data-side="overlay" preserveAspectRatio="xMidYMid meet"><g class="old-layer"></g><g class="new-layer"></g></svg>';
  const oldG = host.querySelector(".old-layer"),
    newG = host.querySelector(".new-layer");
  state.old.entities.forEach((e, i) => oldG.insertAdjacentHTML("beforeend", entitySvg(e, i, "old", state.diffs).replace('class="entity', 'class="entity overlay-old')));
  state.new.entities.forEach((e, i) => newG.insertAdjacentHTML("beforeend", entitySvg(e, i, "new", state.diffs).replace('class="entity', 'class="entity overlay-new')));
  newG.style.opacity = $("#opacityRange").value / 100;
  applyView();
  bindPan(host)
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
  // 대형 도면은 변경점이 수만 건일 수 있으므로 DOM에는 상한까지만 생성한다.
  // 전체 결과는 state.diffs에 남아 CSV 내보내기에서는 손실 없이 사용된다.
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
  // 사용자가 설정한 확대 수준은 유지하고 중심점만 이동한다. 항목을 반복 클릭할 때
  // 계속 확대되던 현상을 방지하기 위해 렌더러에는 위치 정보만 전달한다.
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
  // DWG는 서버 변환 경로, DXF는 브라우저 디코딩 경로를 사용한다. 양쪽 모두 마지막에는
  // 동일한 drawing 구조로 정규화하므로 이후 비교 코드는 파일 형식을 알 필요가 없다.
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
