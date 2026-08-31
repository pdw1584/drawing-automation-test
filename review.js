import { focusCadViews, renderCadFile } from "./cad-renderer.js";

"use strict";

const state = {
  drawing: null,
  documents: [],
  findings: [],
  filter: "all",
  drawingPreview: null,
  page: 1,
  view: null,
  selectedLocation: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character])
}

function extractDxfReviewData(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./review-dxf-worker.js", import.meta.url), {type: "module"});
    worker.onmessage = event => {
      worker.terminate();
      if (event.data?.error) reject(new Error(event.data.error));
      else resolve(event.data)
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || "DXF 문자 추출 Worker 실행에 실패했습니다."))
    };
    worker.postMessage({file})
  })
}
// 도면 검토 체크
function updateReadyState() {
  const ready = state.drawing && state.documents.length;
  $("#reviewBtn").disabled = !ready;
  $("#reviewStatus").textContent = ready ? "검토를 실행할 준비가 되었습니다." : "도면과 문서를 모두 선택하세요."
}

function renderFindings() {
  const rows = state.findings.filter(item => state.filter === "all" || item.status === state.filter);
  $("#reviewList").innerHTML = rows.length ? rows.map(item => `
    <div class="review-row ${item.location ? "has-location" : ""}" data-id="${state.findings.indexOf(item)}">
      <span class="review-status ${item.status}">${item.status === "matched" ? "도면 일치" : "검토 필요"}</span>
      <span>${escapeHtml(item.kind)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <span class="review-evidence">${escapeHtml(item.evidence)}</span>
      <span class="review-source">${escapeHtml(item.source)} · ${item.page}페이지${item.location ? " · 도면 위치 있음" : ""}</span>
    </div>
  `).join("") : `<div class="empty-row">해당 상태의 항목이 없습니다.</div>`;
  for (const row of $$(".review-row.has-location")) {
    row.onclick = () => focusLocation(state.findings[Number(row.dataset.id)].location)
  }
}

function dxfEntitySvg(entity) {
  const points = entity.points || [];
  if (entity.type === "LINE" && points.length > 1) return `<line x1="${points[0].x}" y1="${-points[0].y}" x2="${points[1].x}" y2="${-points[1].y}"/>`;
  if (entity.type === "CIRCLE" && points[0]) return `<circle cx="${points[0].x}" cy="${-points[0].y}" r="${entity.radius || 1}"/>`;
  if (entity.type === "ARC" && points[0]) {
    const radius = entity.radius || 1, start = (entity.startAngle || 0) * Math.PI / 180, end = (entity.endAngle || 0) * Math.PI / 180, delta = ((entity.endAngle || 0) - (entity.startAngle || 0) + 360) % 360,
      x1 = points[0].x + radius * Math.cos(start), y1 = -(points[0].y + radius * Math.sin(start)), x2 = points[0].x + radius * Math.cos(end), y2 = -(points[0].y + radius * Math.sin(end));
    return `<path d="M ${x1} ${y1} A ${radius} ${radius} 0 ${delta > 180 ? 1 : 0} 0 ${x2} ${y2}"/>`
  }
  if (["TEXT", "MTEXT"].includes(entity.type) && points[0]) return `<text x="${points[0].x}" y="${-points[0].y}" font-size="${entity.height||3}" transform="rotate(${-(entity.rotation||0)} ${points[0].x} ${-points[0].y})">${escapeHtml(entity.text)}</text>`;
  if (entity.type === "DIMENSION" && points.length > 2) {
    const first = points.at(-2), second = points.at(-1);
    return `<g><line x1="${first.x}" y1="${-first.y}" x2="${second.x}" y2="${-second.y}"/><line x1="${first.x}" y1="${-first.y}" x2="${points[0].x}" y2="${-points[0].y}"/><line x1="${second.x}" y1="${-second.y}" x2="${points[0].x}" y2="${-points[0].y}"/></g>`
  }
  if (points.length) {
    const pathPoints = entity.closed ? [...points, points[0]] : points;
    let path = `M ${pathPoints[0].x} ${-pathPoints[0].y}`;
    for (let index = 0; index < pathPoints.length - 1; index++) {
      const start = pathPoints[index], end = pathPoints[index + 1], bulge = start.bulge || 0;
      if (!bulge) path += ` L ${end.x} ${-end.y}`;
      else {
        const chord = Math.hypot(end.x-start.x,end.y-start.y), radius = chord*(1+bulge*bulge)/(4*Math.abs(bulge)), angle = 4*Math.atan(Math.abs(bulge));
        path += ` A ${radius} ${radius} 0 ${angle > Math.PI ? 1 : 0} ${bulge > 0 ? 0 : 1} ${end.x} ${-end.y}`
      }
    }
    return `<path d="${path}"/>`
  }
  return ""
}

function renderDrawingPreview() {
  const drawing = state.drawingPreview;
  const host = $("#reviewDrawingViewer");
  if (!drawing) return;
  if (drawing.type === "pdf") {
    const page = drawing.pages[state.page - 1];
    const marker = state.selectedLocation?.page === state.page ? `<rect class="review-location-marker" x="${state.selectedLocation.x}" y="${state.selectedLocation.y}" width="${Math.max(8,state.selectedLocation.w)}" height="${Math.max(8,state.selectedLocation.h)}"/>` : "";
    const focus = state.selectedLocation?.page === state.page ? state.selectedLocation : null;
    const focusSize = focus ? Math.max(120, focus.w * 8, focus.h * 8) : 0;
    const viewBox = focus ? `${Math.max(0,focus.x-focusSize/2)} ${Math.max(0,focus.y-focusSize/2)} ${focusSize} ${focusSize}` : `0 0 ${page.width} ${page.height}`;
    host.innerHTML = `<svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet"><image href="${page.image}" width="${page.width}" height="${page.height}"/>${marker}</svg>`;
    if (!state.view) state.view = {x: 0, y: 0, w: page.width, h: page.height}
  } else if (state.drawing) renderCadFile("review", state.drawing, "#reviewDrawingViewer")
}

function focusLocation(location) {
  state.selectedLocation = location;
  if (state.drawingPreview.type === "pdf") {
    state.page = location.page;
    $("#reviewPageSelect").value = String(location.page)
  }
  if (state.drawingPreview.type === "dxf") {
    focusCadViews({review: {x: location.x, y: location.y}})
  } else renderDrawingPreview();
  const marker = $(".review-location-marker");
  marker?.scrollIntoView({behavior: "smooth", block: "center"})
}

async function runReview() {
  $("#reviewBtn").disabled = true;
  $("#reviewStatus").textContent = "도면 문자와 문서 요구사항을 분석하고 있습니다…";
  try {
    const form = new FormData();
    form.append("drawingName", state.drawing.name);
    if (state.drawing.name.toLowerCase().endsWith(".dxf")) {
      $("#reviewStatus").textContent = "대형 DXF에서 문자와 위치를 추출하고 있습니다…";
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const extracted = await extractDxfReviewData(state.drawing);
      form.append("drawingText", extracted.drawingText);
      form.append("drawingPreview", JSON.stringify(extracted.preview))
    } else form.append("drawing", state.drawing);
    form.append("names", JSON.stringify(state.documents.map(file => file.name)));
    state.documents.forEach((file, index) => form.append(`doc${index}`, file));
    const response = await fetch("/api/review", {
      method: "POST",
      body: form
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "문서 검토에 실패했습니다.");
    state.findings = result.findings;
    state.drawingPreview = result.drawing;
    state.page = 1;
    state.selectedLocation = null;
    if (result.drawing?.type === "pdf") {
      $("#reviewPageControl").hidden = false;
      $("#reviewPageSelect").innerHTML = result.drawing.pages.map(page => `<option value="${page.number}">${page.number} / ${result.drawing.pages.length}</option>`).join("")
    } else {
      $("#reviewPageControl").hidden = true
    }
    renderDrawingPreview();
    const summary = result.summary;
    $("#reviewSummary").textContent = `요구사항 ${summary.total}건 · 도면 일치 ${summary.matched}건 · 검토 필요 ${summary.review}건`;
    $("#reviewStatus").textContent = "문서 기반 검토를 완료했습니다.";
    renderFindings()
  } catch (error) {
    $("#reviewStatus").textContent = error instanceof TypeError ? "검토 서버 연결이 중단되었습니다. 서버가 실행 중인지와 PowerShell 창의 오류 메시지를 확인하세요." : error.message
  } finally {
    $("#reviewBtn").disabled = false
  }
}

$("#drawingFile").onchange = event => {
  state.drawing = event.target.files[0] || null;
  $("#drawingName").textContent = state.drawing ? `${state.drawing.name} · ${(state.drawing.size / 1024 / 1024).toFixed(2)}MB` : "DXF 또는 PDF 도면 한 개를 선택하세요.";
  if (state.drawing?.name.toLowerCase().endsWith(".dxf")) {
    renderCadFile("review", state.drawing, "#reviewDrawingViewer")
  } else if (state.drawing) {
    $("#reviewDrawingViewer").innerHTML = '<div class="empty">검토 실행 후 PDF 도면이 표시됩니다.</div>'
  }
  updateReadyState()
};

$("#documentFiles").onchange = event => {
  state.documents = [...event.target.files];
  const documentNames = state.documents.map(file => file.name);
  $("#documentNames").textContent = state.documents.length
    ? `선택 ${state.documents.length}개\n${documentNames.map((name, index) => `${index + 1}. ${name}`).join("\n")}`
    : "시방서·승인서 등을 여러 개 선택할 수 있습니다.";
  $("#documentNames").title = documentNames.join("\n");
  updateReadyState()
};

$("#reviewBtn").onclick = runReview;
$("#reviewPageSelect").onchange = event => {
  state.page = Number(event.target.value);
  state.selectedLocation = null;
  state.view = null;
  renderDrawingPreview()
};

for (const button of $$('[data-review-filter]')) {
  button.onclick = () => {
    $$('[data-review-filter]').forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    state.filter = button.dataset.reviewFilter;
    renderFindings()
  }
}
