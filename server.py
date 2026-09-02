"""도면자동화 v0.8.0 로컬 서버 진입점. 실제 기능은 server_modules에 분리되어 있다."""

import sys
from http.server import ThreadingHTTPServer
from server_modules.handler import Handler

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"도면자동화 v0.8.0: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
