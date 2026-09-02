from email.parser import BytesParser
from email.policy import default

def parse_multipart(content_type: str, body: bytes) -> dict[str, bytes]:
    """브라우저가 전송한 multipart/form-data를 파일명과 원본 바이트 중심으로 정리한다.

    대용량 CAD 파일을 텍스트로 변환하지 않고 bytes 상태로 유지해야 인코딩 손상과
    불필요한 메모리 복사를 줄일 수 있다.
    """
    message = BytesParser(policy=default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
    )
    files: dict[str, bytes] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            files[name] = part.get_payload(decode=True) or b""
    return files
