import json
import unittest

import fitz

from server_modules.documents import dxf_preview
from server_modules.handler import Handler
from server_modules.multipart import parse_multipart
from server_modules.pdf_compare import compare_pdfs
from server_modules.review import normalized, review_documents


class ServerModuleTests(unittest.TestCase):
    def test_multipart_parser_keeps_binary_payload(self):
        boundary = "test-boundary"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="drawing"; filename="a.dxf"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + b"DXF\x00DATA" + f"\r\n--{boundary}--\r\n".encode()
        fields = parse_multipart(f"multipart/form-data; boundary={boundary}", body)
        self.assertEqual(fields["drawing"], b"DXF\x00DATA")

    def test_dxf_preview_extracts_text_location(self):
        source = b"0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\nNOTE\n10\n10\n20\n20\n40\n3\n1\nUPS\n0\nENDSEC\n0\nEOF\n"
        result = dxf_preview(source)
        self.assertEqual(result["textItems"][0]["text"], "UPS")
        self.assertEqual(result["textItems"][0]["x"], 10)

    def test_document_requirement_matches_drawing_text(self):
        fields = {
            "names": json.dumps(["spec.txt"]).encode(),
            "doc0": "재질은 SUS 304로 한다".encode(),
            "drawingText": "SUS304".encode(),
        }
        result = review_documents(fields)
        self.assertEqual(result["summary"]["matched"], 1)
        self.assertEqual(normalized("SUS 304"), "SUS304")

    def test_pdf_compare_reports_added_text(self):
        old_document = fitz.open()
        old_document.new_page()
        new_document = fitz.open()
        page = new_document.new_page()
        page.insert_text((72, 72), "NEW NOTE")
        result = compare_pdfs(old_document.tobytes(), new_document.tobytes())
        self.assertEqual(result["pageCount"], 1)
        self.assertTrue(any(change["kind"] == "added" for change in result["changes"]))

    def test_legacy_page_aliases_are_preserved(self):
        self.assertEqual(Handler.PAGE_ALIASES["/review.html"], "/pages/review.html")
        self.assertEqual(Handler.PAGE_ALIASES["/cad-frame.html"], "/pages/cad-frame.html")


if __name__ == "__main__":
    unittest.main()
