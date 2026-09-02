import re
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree
import fitz
from .pdf_images import png_data

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
    """서버 문서 대조용으로 DXF의 TEXT/MTEXT 값(group code 1, 3)을 빠르게 추출한다.

    이 경로는 전체 CAD 파서가 아니라 요구사항 키워드 대조용 경량 추출기다. 브라우저의
    장비 분석과 렌더링에서는 별도의 코드페이지 감지기(dxf-encoding.js)를 사용한다.
    """
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
    """문서 검토 응답에 포함할 경량 DXF 미리보기 엔티티를 생성한다.

    전체 렌더링 데이터 대신 검토 위치 표시에 필요한 도형과 텍스트만 반환하며,
    블록 전개에는 별도의 개수 제한을 적용해 취합 도면의 메모리 폭증을 방지한다.
    """
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
    """INSERT를 반복형 스택으로 전개하고 순환 블록 및 최대 객체 수를 제한한다."""
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
