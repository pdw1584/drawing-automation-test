"""Drawing Delta local server with PDF comparison support."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from email.parser import BytesParser
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from io import BytesIO
from xml.etree import ElementTree

import fitz


ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / "dist" if (ROOT / "dist" / "index.html").is_file() else ROOT
MAX_UPLOAD = int(os.environ.get("DRAWING_AUTOMATION_MAX_UPLOAD", "0"))


def parse_multipart(content_type: str, body: bytes) -> dict[str, bytes]:
    message = BytesParser(policy=default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    files: dict[str, bytes] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            files[name] = part.get_payload(decode=True) or b""
    return files


def png_data(pixmap: fitz.Pixmap) -> str:
    encoded = base64.b64encode(pixmap.tobytes("png")).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def changed_tiles(a: fitz.Pixmap, b: fitz.Pixmap, tile: int = 24) -> list[dict]:
    width, height = min(a.width, b.width), min(a.height, b.height)
    samples_a, samples_b = a.samples, b.samples
    stride_a, stride_b = a.stride, b.stride
    channels_a, channels_b = a.n, b.n
    active: set[tuple[int, int]] = set()

    for ty, y in enumerate(range(0, height, tile)):
        for tx, x in enumerate(range(0, width, tile)):
            changed = checked = 0
            for py in range(y, min(y + tile, height), 3):
                for px in range(x, min(x + tile, width), 3):
                    ia, ib = py * stride_a + px * channels_a, py * stride_b + px * channels_b
                    delta = sum(abs(samples_a[ia + c] - samples_b[ib + c]) for c in range(3)) / 3
                    changed += delta > 38
                    checked += 1
            if checked and changed / checked > 0.075:
                active.add((tx, ty))

    regions: list[dict] = []
    while active:
        start = active.pop()
        stack, group = [start], [start]
        while stack:
            tx, ty = stack.pop()
            for neighbor in ((tx - 1, ty), (tx + 1, ty), (tx, ty - 1), (tx, ty + 1)):
                if neighbor in active:
                    active.remove(neighbor)
                    stack.append(neighbor)
                    group.append(neighbor)
        xs, ys = [p[0] for p in group], [p[1] for p in group]
        x, y = min(xs) * tile, min(ys) * tile
        w = min(width, (max(xs) + 1) * tile) - x
        h = min(height, (max(ys) + 1) * tile) - y
        if w * h >= tile * tile:
            regions.append({"x": x, "y": y, "w": w, "h": h, "area": w * h})

    if a.width != b.width or a.height != b.height:
        regions.append({"x": 0, "y": 0, "w": max(a.width, b.width), "h": max(a.height, b.height), "area": 0, "sizeChange": True})
    return sorted(regions, key=lambda item: item["area"], reverse=True)[:100]


def clean_lines(text: str) -> set[str]:
    return {re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if len(line.strip()) >= 2}


def extract_document(data: bytes, filename: str) -> list[tuple[int, str]]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        document = fitz.open(stream=data, filetype="pdf")
        pages = [(index + 1, page.get_text()) for index, page in enumerate(document)]
        document.close()
        return pages
    if suffix == ".docx":
        with zipfile.ZipFile(BytesIO(data)) as archive:
            xml = archive.read("word/document.xml")
        root = ElementTree.fromstring(xml)
        namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragraphs = []
        for paragraph in root.iter(f"{namespace}p"):
            text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t"))
            if text.strip():
                paragraphs.append(text)
        return [(1, "\n".join(paragraphs))]
    return [(1, data.decode("utf-8", errors="replace"))]


def extract_dxf_text(data: bytes) -> str:
    lines = data.decode("utf-8", errors="replace").replace("\r", "").split("\n")
    values = []
    for index in range(0, len(lines) - 1, 2):
        if lines[index].strip() in {"1", "3"}:
            value = lines[index + 1].strip()
            if value:
                values.append(value)
    return "\n".join(values)


def dxf_review_preview(data: bytes) -> dict:
    """Extract drawing text and top-level text locations without expanding CAD geometry."""
    lines = data.decode("utf-8", errors="replace").replace("\r", "").split("\n")
    text_items: list[dict] = []
    all_text: list[str] = []
    section = None
    awaiting_section_name = False
    current = None
    block_count = 0

    def finish() -> None:
        nonlocal current
        if not current:
            return
        text = "".join(current["text"]).strip()
        if text:
            all_text.append(text)
            if current["section"] == "ENTITIES":
                text_items.append({
                    "text": text,
                    "page": 1,
                    "x": current["x"],
                    "y": current["y"],
                    "w": max(8, len(text) * max(current["height"], 1) * 0.6),
                    "h": max(4, current["height"]),
                })
        current = None

    for index in range(0, len(lines) - 1, 2):
        code, value = lines[index].strip(), lines[index + 1].strip()
        if code == "0":
            finish()
            if value == "SECTION":
                awaiting_section_name = True
                section = None
                continue
            if value == "ENDSEC":
                section = None
                continue
            if section == "BLOCKS" and value == "BLOCK":
                block_count += 1
            if section in {"ENTITIES", "BLOCKS"} and value in {"TEXT", "MTEXT", "ATTRIB", "ATTDEF"}:
                current = {"section": section, "text": [], "x": 0.0, "y": 0.0, "height": 3.0}
            continue
        if awaiting_section_name and code == "2":
            section = value
            awaiting_section_name = False
            continue
        if not current:
            continue
        if code in {"1", "3"}:
            current["text"].append(value)
        elif code == "10":
            current["x"] = float(value or 0)
        elif code == "20":
            current["y"] = float(value or 0)
        elif code == "40":
            current["height"] = float(value or 3)
    finish()
    return {
        "type": "dxf",
        "bounds": {"minX": 0, "minY": 0, "maxX": 100, "maxY": 100},
        "textItems": text_items,
        "blockCount": block_count,
        "_drawingText": "\n".join(all_text),
    }


def extract_drawing_text(data: bytes, filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".dxf":
        return extract_dxf_text(data)
    if suffix == ".pdf":
        return "\n".join(text for _, text in extract_document(data, filename))
    raise ValueError("검토 도면은 DXF 또는 PDF 형식이어야 합니다.")


def dxf_preview(data: bytes, expand_blocks: bool = True) -> dict:
    lines = data.decode("utf-8", errors="replace").replace("\r", "").split("\n")
    pairs = [(lines[index].strip(), lines[index + 1].strip()) for index in range(0, len(lines) - 1, 2)]
    entities, current, in_entities = [], None, False

    def finish() -> None:
        nonlocal current
        if current and current["type"] in {"LINE", "CIRCLE", "ARC", "LWPOLYLINE", "TEXT", "MTEXT", "INSERT", "POINT", "DIMENSION"}:
            entities.append(current)
        current = None

    for code, value in pairs:
        if code == "2" and value == "ENTITIES":
            in_entities = True
            continue
        if in_entities and code == "0" and value == "ENDSEC":
            finish()
            in_entities = False
            continue
        if not in_entities:
            continue
        if code == "0":
            finish()
            current = {"type": value, "layer": "0", "points": [], "text": ""}
            continue
        if not current:
            continue
        if code == "8":
            current["layer"] = value
        elif code == "10":
            current.setdefault("xs", []).append(float(value or 0))
        elif code == "20":
            xs = current.get("xs", [0])
            current["points"].append({"x": xs[min(len(current["points"]), len(xs) - 1)], "y": float(value or 0)})
        elif code == "11":
            current["x2"] = float(value or 0)
        elif code == "21":
            current["y2"] = float(value or 0)
        elif code == "13":
            current["x3"] = float(value or 0)
        elif code == "23":
            current["y3"] = float(value or 0)
        elif code == "14":
            current["x4"] = float(value or 0)
        elif code == "24":
            current["y4"] = float(value or 0)
        elif code == "40":
            if current["type"] in {"CIRCLE", "ARC"}:
                current["radius"] = float(value or 0)
            else:
                current["height"] = float(value or 0)
        elif code == "41" and current["type"] == "INSERT":
            current["scaleX"] = float(value or 1)
        elif code == "42" and current["type"] == "INSERT":
            current["scaleY"] = float(value or 1)
        elif code == "42" and current["points"]:
            current["points"][-1]["bulge"] = float(value or 0)
        elif code == "50":
            current["startAngle" if current["type"] == "ARC" else "rotation"] = float(value or 0)
        elif code == "51":
            current["endAngle"] = float(value or 0)
        elif code == "70":
            current["flags"] = int(value or 0)
        elif code in {"1", "3"}:
            current["text"] += value
        elif code == "2":
            current["block"] = value
    finish()

    for entity in entities:
        if entity["type"] == "LINE" and entity["points"]:
            entity["points"].append({"x": entity.get("x2", entity["points"][0]["x"]), "y": entity.get("y2", entity["points"][0]["y"])})
        if entity["type"] == "DIMENSION":
            for x_key, y_key in (("x2", "y2"), ("x3", "y3"), ("x4", "y4")):
                if x_key in entity and y_key in entity:
                    entity["points"].append({"x": entity[x_key], "y": entity[y_key]})
        entity["closed"] = bool(entity.get("flags", 0) & 1)
        entity.pop("xs", None)
        entity.pop("x2", None)
        entity.pop("y2", None)

    blocks = parse_dxf_blocks(pairs) if expand_blocks else {}
    if blocks:
        entities = expand_dxf_blocks(entities, blocks)
    coordinates = [point for entity in entities for point in entity["points"]]
    if coordinates:
        xs, ys = [point["x"] for point in coordinates], [point["y"] for point in coordinates]
        bounds = {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys)}
    else:
        bounds = {"minX": 0, "minY": 0, "maxX": 100, "maxY": 100}
    text_items = [
        {"text": entity["text"], "page": 1, "x": entity["points"][0]["x"], "y": entity["points"][0]["y"], "w": 8, "h": 4}
        for entity in entities if entity["text"] and entity["points"]
    ]
    return {"type": "dxf", "entities": entities, "bounds": bounds, "textItems": text_items, "blockCount": len(blocks)}


def parse_dxf_blocks(pairs: list[tuple[str, str]]) -> dict:
    blocks, in_blocks, index = {}, False, 0
    while index < len(pairs):
        code, value = pairs[index]
        if code == "2" and value == "BLOCKS":
            in_blocks = True
        elif in_blocks and code == "0" and value == "ENDSEC":
            break
        elif in_blocks and code == "0" and value == "BLOCK":
            end = index + 1
            while end < len(pairs) and pairs[end] != ("0", "ENDBLK"):
                end += 1
            content = pairs[index + 1:end]
            first_entity = next((position for position, pair in enumerate(content) if pair[0] == "0"), len(content))
            header, entity_pairs = content[:first_entity], content[first_entity:]
            name = next((item[1] for item in header if item[0] == "2"), None)
            if name:
                base_x = float(next((item[1] for item in header if item[0] == "10"), 0))
                base_y = float(next((item[1] for item in header if item[0] == "20"), 0))
                entity_text = "\n".join(value for pair in entity_pairs for value in pair)
                synthetic = f"0\nSECTION\n2\nENTITIES\n{entity_text}\n0\nENDSEC\n0\nEOF\n".encode()
                blocks[name] = {"base": {"x": base_x, "y": base_y}, "entities": dxf_preview(synthetic, False)["entities"]}
            index = end
        index += 1
    return blocks


def transform_dxf_block_entity(source: dict, insert: dict, base: dict) -> dict:
    entity = {**source, "points": [{**point} for point in source["points"]]}
    angle = insert.get("rotation", 0) * 3.141592653589793 / 180
    cos_value, sin_value = __import__("math").cos(angle), __import__("math").sin(angle)
    scale_x, scale_y = insert.get("scaleX", 1), insert.get("scaleY", 1)
    origin = insert["points"][0] if insert["points"] else {"x": 0, "y": 0}
    for point in entity["points"]:
        x, y = (point["x"] - base["x"]) * scale_x, (point["y"] - base["y"]) * scale_y
        point["x"] = origin["x"] + cos_value * x - sin_value * y
        point["y"] = origin["y"] + sin_value * x + cos_value * y
    average_scale = (abs(scale_x) + abs(scale_y)) / 2
    if entity.get("radius"):
        entity["radius"] *= average_scale
    if entity.get("height"):
        entity["height"] *= average_scale
    entity["rotation"] = entity.get("rotation", 0) + insert.get("rotation", 0)
    entity["scaleX"] = entity.get("scaleX", 1) * scale_x
    entity["scaleY"] = entity.get("scaleY", 1) * scale_y
    if entity.get("layer") == "0":
        entity["layer"] = insert.get("layer", "0")
    entity["fromBlock"] = insert.get("block")
    return entity


def expand_dxf_blocks(entities: list[dict], blocks: dict, max_entities: int = 1_000_000) -> list[dict]:
    expanded: list[dict] = []
    stack = [(entity, frozenset()) for entity in reversed(entities)]
    while stack and len(expanded) < max_entities:
        entity, ancestry = stack.pop()
        expanded.append(entity)
        block_name = entity.get("block") if entity.get("type") == "INSERT" else None
        definition = blocks.get(block_name)
        if not definition or block_name in ancestry:
            continue
        next_ancestry = ancestry | {block_name}
        children = [
            transform_dxf_block_entity(child, entity, definition["base"])
            for child in definition["entities"]
        ]
        stack.extend((child, next_ancestry) for child in reversed(children))
    return expanded


def pdf_preview(data: bytes) -> dict:
    document = fitz.open(stream=data, filetype="pdf")
    matrix = fitz.Matrix(1.15, 1.15)
    pages, text_items = [], []
    for index, page in enumerate(document):
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        pages.append({"number": index + 1, "width": pixmap.width, "height": pixmap.height, "image": png_data(pixmap)})
        for block in page.get_text("words"):
            x0, y0, x1, y1, word = block[:5]
            text_items.append({"text": word, "page": index + 1, "x": x0 * matrix.a, "y": y0 * matrix.d, "w": (x1 - x0) * matrix.a, "h": (y1 - y0) * matrix.d})
    document.close()
    return {"type": "pdf", "pages": pages, "textItems": text_items}


def drawing_preview(data: bytes, filename: str) -> dict:
    return pdf_preview(data) if Path(filename).suffix.lower() == ".pdf" else dxf_preview(data)


def find_oda_converter() -> str | None:
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


REQUIREMENT_PATTERNS = [
    ("재질", re.compile(r"(?<![A-Z0-9])(?:SUS\s*\d{3}|SS\s*\d{3}|SM\s*\d{3}|AL\s*\d{4}|STAINLESS\s+STEEL|STEEL|PVC|CPVC|HDPE)(?![A-Z0-9])", re.I)),
    ("치수/규격", re.compile(r"(?<![A-Z0-9])(?:Ø|D)?\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|t|A)(?![A-Z0-9])", re.I)),
    ("규격", re.compile(r"(?<![A-Z0-9])\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?(?![A-Z0-9])", re.I)),
    ("수량", re.compile(r"(?<![A-Z0-9])\d+\s*(?:EA|SET|개|대|조)(?![A-Z0-9])", re.I)),
    ("모델", re.compile(r"\b(?:MODEL|TYPE|형식|모델)\s*[:：]?\s*([A-Z0-9][A-Z0-9._/-]{2,})", re.I)),
]


def normalized(value: str) -> str:
    return re.sub(r"[\s,]", "", value).upper().replace("×", "X")


def review_documents(fields: dict[str, bytes]) -> dict:
    names = json.loads(fields.get("names", b"[]").decode("utf-8"))
    drawing_text = fields.get("drawingText", b"").decode("utf-8", errors="replace")
    preview = None
    if fields.get("drawingPreview"):
        preview = json.loads(fields["drawingPreview"].decode("utf-8"))
    if fields.get("drawing"):
        drawing_name = fields.get("drawingName", b"drawing.dxf").decode("utf-8", errors="replace")
        if Path(drawing_name).suffix.lower() == ".dxf":
            preview = dxf_review_preview(fields["drawing"])
            lightweight_drawing_text = preview.pop("_drawingText", "")
        else:
            preview = drawing_preview(fields["drawing"], drawing_name)
            lightweight_drawing_text = ""
        if not drawing_text.strip():
            drawing_text = lightweight_drawing_text or "\n".join(item["text"] for item in preview["textItems"])
    drawing_normalized = normalized(drawing_text)
    findings, seen = [], set()

    for index, filename in enumerate(names):
        data = fields.get(f"doc{index}")
        if not data:
            continue
        for page, text in extract_document(data, filename):
            for line_number, line in enumerate(text.splitlines(), 1):
                compact_line = re.sub(r"\s+", " ", line).strip()
                if not compact_line:
                    continue
                for kind, pattern in REQUIREMENT_PATTERNS:
                    for match in pattern.finditer(compact_line):
                        value = match.group(1) if kind == "모델" and match.lastindex else match.group(0)
                        key = (filename, page, kind, normalized(value))
                        if key in seen:
                            continue
                        seen.add(key)
                        found = normalized(value) in drawing_normalized
                        findings.append({
                            "kind": kind,
                            "value": value.strip(),
                            "status": "matched" if found else "review",
                            "source": filename,
                            "page": page,
                            "line": line_number,
                            "evidence": compact_line[:240],
                            "location": next(({
                                "page": item["page"],
                                "x": item["x"],
                                "y": item["y"],
                                "w": item["w"],
                                "h": item["h"],
                            } for item in (preview or {}).get("textItems", []) if normalized(value) in normalized(item["text"])), None),
                        })
    if preview and preview.get("type") == "dxf":
        preview = {
            "type": "dxf",
            "bounds": preview["bounds"],
            "textItems": preview["textItems"],
            "blockCount": preview["blockCount"],
        }
    return {
        "findings": findings,
        "summary": {
            "total": len(findings),
            "matched": sum(item["status"] == "matched" for item in findings),
            "review": sum(item["status"] == "review" for item in findings),
        },
        "drawing": preview,
    }


def compare_pdfs(old_bytes: bytes, new_bytes: bytes) -> dict:
    old_doc, new_doc = fitz.open(stream=old_bytes, filetype="pdf"), fitz.open(stream=new_bytes, filetype="pdf")
    pages, changes = [], []
    page_count = max(old_doc.page_count, new_doc.page_count)
    matrix = fitz.Matrix(1.35, 1.35)

    for index in range(page_count):
        old_page = old_doc[index] if index < old_doc.page_count else None
        new_page = new_doc[index] if index < new_doc.page_count else None
        old_pix = old_page.get_pixmap(matrix=matrix, alpha=False) if old_page else None
        new_pix = new_page.get_pixmap(matrix=matrix, alpha=False) if new_page else None

        if old_pix and new_pix:
            regions = changed_tiles(old_pix, new_pix)
            width, height = max(old_pix.width, new_pix.width), max(old_pix.height, new_pix.height)
        else:
            pix = old_pix or new_pix
            width, height = pix.width, pix.height
            regions = [{"x": 0, "y": 0, "w": width, "h": height, "area": width * height, "wholePage": True}]

        page_changes = []
        for region_index, region in enumerate(regions, 1):
            change = {
                "id": f"p{index + 1}-{region_index}",
                "page": index + 1,
                "kind": "changed" if old_pix and new_pix else ("removed" if old_pix else "added"),
                "box": region,
                "detail": f"{index + 1}페이지 변경 영역 {region_index}",
            }
            changes.append(change)
            page_changes.append(change["id"])

        old_text = clean_lines(old_page.get_text()) if old_page else set()
        new_text = clean_lines(new_page.get_text()) if new_page else set()
        text_differences = [
            ("added", text, new_page) for text in sorted(new_text - old_text)[:30]
        ] + [
            ("removed", text, old_page) for text in sorted(old_text - new_text)[:30]
        ]
        for text_index, (kind, text, source_page) in enumerate(text_differences, 1):
            matches = source_page.search_for(text) if source_page else []
            if not matches:
                continue
            rect = matches[0]
            box = {
                "x": rect.x0 * matrix.a,
                "y": rect.y0 * matrix.d,
                "w": rect.width * matrix.a,
                "h": rect.height * matrix.d,
                "area": rect.width * rect.height * matrix.a * matrix.d,
            }
            change = {
                "id": f"p{index + 1}-text-{text_index}",
                "page": index + 1,
                "kind": kind,
                "box": box,
                "detail": f"문자 {'추가' if kind == 'added' else '삭제'}: {text[:120]}",
            }
            changes.append(change)
            page_changes.append(change["id"])
        pages.append({
            "number": index + 1,
            "width": width,
            "height": height,
            "oldImage": png_data(old_pix) if old_pix else None,
            "newImage": png_data(new_pix) if new_pix else None,
            "changeIds": page_changes,
            "textAdded": sorted(new_text - old_text)[:50],
            "textRemoved": sorted(old_text - new_text)[:50],
            "oldText": sorted(old_text),
            "newText": sorted(new_text),
        })

    old_doc.close()
    new_doc.close()
    return {"type": "pdf", "pageCount": page_count, "pages": pages, "changes": changes}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def end_headers(self) -> None:
        request_path = self.path.split("?", 1)[0].lower()
        if request_path.endswith((".html", ".js")) or request_path == "/":
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.send_header("Permissions-Policy", "unload=(self)")
        super().end_headers()

    def do_POST(self) -> None:
        request_path = self.path.split("?", 1)[0].rstrip("/")
        if request_path not in {"/api/pdf/compare", "/api/review", "/api/dwg/convert", "/api/converter/status"}:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                raise ValueError("업로드 데이터가 없습니다.")
            if MAX_UPLOAD > 0 and length > MAX_UPLOAD:
                raise ValueError(f"업로드 크기는 {MAX_UPLOAD / 1024 / 1024:.0f}MB 이하여야 합니다.")
            fields = parse_multipart(self.headers.get("Content-Type", ""), self.rfile.read(length))
            if request_path == "/api/dwg/convert":
                names = json.loads(fields.get("names", b"[]").decode("utf-8"))
                items = [(name, fields.get(f"dwg{index}", b"")) for index, name in enumerate(names)]
                items = [(name, data) for name, data in items if data]
                if not items:
                    raise ValueError("DWG 파일이 필요합니다.")
                if len(items) > 50:
                    raise ValueError("한 번에 최대 50개까지 변환할 수 있습니다.")
                output_name, content_type, output = convert_dwgs(items)
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Disposition", f'attachment; filename="{output_name}"')
                self.send_header("Content-Length", str(len(output)))
                self.end_headers()
                self.wfile.write(output)
                return
            if request_path == "/api/converter/status":
                payload = {"available": bool(find_oda_converter())}
            elif request_path == "/api/pdf/compare":
                if not fields.get("old") or not fields.get("new"):
                    raise ValueError("PDF 두 파일이 모두 필요합니다.")
                payload = compare_pdfs(fields["old"], fields["new"])
            else:
                payload = review_documents(fields)
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            encoded = json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8")
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"도면자동화 v0.1: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
