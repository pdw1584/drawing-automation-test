"use strict";

const state = {
  files: [],
  available: false
};

const $ = selector => document.querySelector(selector);

// ODA 설치경로 확인 요청 
async function checkConverter() {
  // 페이지 진입 시 서버가 실제 ODA 실행 파일을 찾았는지 확인한다. UI의 활성 상태와
  // 서버 변환 가능 상태가 어긋나지 않도록 확인이 끝나기 전에는 변환 버튼을 잠근다.
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
  // Windows 예약문자와 경로 구분자를 제거해 Content-Disposition 및 로컬 저장에서
  // 사용자 지정 ZIP 이름이 잘못된 경로나 빈 파일명이 되지 않게 한다.
  if (state.files.length === 1) return state.files[0].name.replace(/\.dwg$/i, ".dxf");
  const fallback = "converted-dxf";
  const base = ($("#outputName").value.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(dxf|zip)$/i, "");
  return `${base || fallback}.zip`
}
// dwg to dxf 변환 
async function convert() {
  // 단일 파일은 DXF 그대로, 여러 파일은 사용자 지정 이름의 ZIP으로 내려받는다.
  // 응답 Blob URL은 클릭 직후 해제해 반복 변환 시 브라우저 메모리가 누적되지 않게 한다.
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
