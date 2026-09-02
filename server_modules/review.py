import json
import re
from pathlib import Path
from .documents import dxf_review_preview, drawing_preview, extract_document

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
    """시방/승인 문서의 요구사항과 도면 텍스트를 대조해 근거 및 위치 후보를 생성한다."""
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
