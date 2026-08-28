"use strict";

const state = {
  files: [],
  available: false
};

const $ = selector => document.querySelector(selector);

// ODA 설치경로 확인 요청 
async function checkConverter() {
  try {
    const form = new FormData();
    form.append("check", "1");
    const response = await fetch("/api/converter/status", {
      method: "POST",
      body: form
    });
    const result = await response.json();
    state.available = result.available;
    $("#converterState").className = `converter-state ${result.available ? "ready" : "unavailable"}`;
    $("#converterState").textContent = result.available ? "ODA 변환기가 연결되었습니다." : "ODA 변환기가 설치되지 않았거나 경로를 찾지 못했습니다.";
    updateButton()
  } catch (error) {
    $("#converterState").className = "converter-state unavailable";
    $("#converterState").textContent = "변환 서버에 연결할 수 없습니다."
  }
}
// 변환 완료 zip 파일 이름 변경 버튼
function updateButton() {
  const hasName = state.files.length <= 1 || $("#outputName").value.trim().length > 0;
  $("#convertBtn").disabled = !state.files.length || !state.available || !hasName
}
// 변환 완료 zip 파일 이름 변경 칸
function safeDownloadName() {
  if (state.files.length === 1) return state.files[0].name.replace(/\.dwg$/i, ".dxf");
  const fallback = "converted-dxf";
  const base = ($("#outputName").value.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(dxf|zip)$/i, "");
  return `${base || fallback}.zip`
}
// dwg to dxf 변환 
async function convert() {
  $("#convertBtn").disabled = true;
  $("#convertStatus").textContent = "DWG 파일을 변환하고 있습니다…";
  try {
    const form = new FormData();
    form.append("names", JSON.stringify(state.files.map(file => file.name)));
    state.files.forEach((file, index) => form.append(`dwg${index}`, file));
    const response = await fetch("/api/dwg/convert", {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "DWG 변환에 실패했습니다.")
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName();
    anchor.click();
    URL.revokeObjectURL(url);
    $("#convertStatus").textContent = "변환을 완료해 DXF 파일을 다운로드했습니다."
  } catch (error) {
    $("#convertStatus").textContent = error.message
  } finally {
    updateButton()
  }
}

$("#dwgFile").onchange = event => {
  state.files = [...event.target.files];
  const totalSize = state.files.reduce((sum, file) => sum + file.size, 0);
  $("#dwgName").textContent = state.files.length ? `${state.files.length}개 파일 · ${(totalSize / 1024 / 1024).toFixed(2)}MB · ${state.files.map(file => file.name).join(" / ")}` : "변환할 DWG 파일들을 선택하세요.";
  const isBatch = state.files.length > 1;
  $("#outputNameField").hidden = !isBatch;
  $("#outputName").disabled = !isBatch;
  $("#outputName").value = isBatch ? "converted-dxf" : "";
  updateButton()
};

$("#outputName").oninput = updateButton;

$("#convertBtn").onclick = convert;
checkConverter();
