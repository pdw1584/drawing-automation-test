import json
from http.server import SimpleHTTPRequestHandler
from .config import MAX_UPLOAD, STATIC_ROOT
from .converter import convert_dwgs, find_oda_converter
from .multipart import parse_multipart
from .pdf_compare import compare_pdfs
from .review import review_documents

class Handler(SimpleHTTPRequestHandler):
    """정적 빌드 결과와 변환·검토 API를 함께 제공하는 로컬 전용 HTTP 처리기."""
    PAGE_ALIASES = {
        "/review.html": "/pages/review.html",
        "/convert.html": "/pages/convert.html",
        "/render-test.html": "/pages/render-test.html",
        "/cad-frame.html": "/pages/cad-frame.html",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def do_GET(self) -> None:
        """기존 공개 URL을 유지하면서 실제 HTML은 pages 디렉터리에서 제공한다."""
        request_path, separator, query = self.path.partition("?")
        mapped_path = self.PAGE_ALIASES.get(request_path)
        if mapped_path:
            self.path = mapped_path + (separator + query if separator else "")
        super().do_GET()

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
