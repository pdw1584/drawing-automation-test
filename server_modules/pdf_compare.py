import fitz
from .documents import clean_lines
from .pdf_images import changed_tiles, png_data

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
