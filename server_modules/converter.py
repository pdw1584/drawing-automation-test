import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path

def find_oda_converter() -> str | None:
    """환경 변수와 Windows의 일반 설치 위치에서 ODAFileConverter 실행 파일을 찾는다."""
    configured = os.environ.get("ODA_FILE_CONVERTER")
    if configured and Path(configured).is_dir():
        configured = str(Path(configured) / "ODAFileConverter.exe")
    oda_root = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ODA"
    versioned = sorted(
        oda_root.glob("ODAFileConverter*/ODAFileConverter.exe"),
        reverse=True,
    ) if oda_root.is_dir() else []
    candidates = [
        configured,
        shutil.which("ODAFileConverter"),
        r"C:\Program Files\ODA\ODAFileConverter 27.1.0\ODAFileConverter.exe",
        r"C:\Program Files\ODA\ODAFileConverter\ODAFileConverter.exe",
        r"C:\Program Files\ODA\ODAFile Converter\ODAFileConverter.exe",
        *[str(path) for path in versioned],
    ]
    return next((path for path in candidates if path and Path(path).is_file()), None)


def convert_dwgs(items: list[tuple[str, bytes]]) -> tuple[str, str, bytes]:
    """업로드된 DWG를 임시 폴더에서 변환하고 단일 DXF 또는 ZIP 응답을 만든다.

    사용자 파일은 작업별 임시 디렉터리에서만 다루며 요청 종료 시 제거된다. 여러 파일은
    이름 충돌을 정리한 뒤 ZIP으로 묶고, 한 파일은 불필요한 압축 없이 바로 반환한다.
    """
    converter = find_oda_converter()
    if not converter:
        raise RuntimeError("ODA File Converter가 설치되지 않았습니다. 설치 후 ODA_FILE_CONVERTER 환경 변수에 실행 파일 경로를 지정하세요.")
    with tempfile.TemporaryDirectory(prefix="drawing_delta_") as temp:
        root = Path(temp)
        input_dir, output_dir = root / "input", root / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        used_names: set[str] = set()
        for index, (filename, data) in enumerate(items, 1):
            safe_stem = re.sub(r"[^A-Za-z0-9가-힣._-]", "_", Path(filename).stem) or f"drawing-{index}"
            candidate = safe_stem
            suffix = 2
            while candidate.lower() in used_names:
                candidate = f"{safe_stem}-{suffix}"
                suffix += 1
            used_names.add(candidate.lower())
            (input_dir / f"{candidate}.dwg").write_bytes(data)
        command = [converter, str(input_dir), str(output_dir), "ACAD2018", "DXF", "0", "1", "*.dwg"]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
        outputs = sorted(output_dir.glob("*.dxf"))
        if completed.returncode != 0 or not outputs:
            detail = (completed.stderr or completed.stdout or "변환 결과 파일이 없습니다.").strip()
            raise RuntimeError(f"DWG 변환 실패: {detail[:300]}")
        if len(outputs) == 1:
            return outputs[0].name, "application/dxf", outputs[0].read_bytes()
        archive_buffer = BytesIO()
        with zipfile.ZipFile(archive_buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for output in outputs:
                archive.write(output, output.name)
        return "converted-dxf.zip", "application/zip", archive_buffer.getvalue()
