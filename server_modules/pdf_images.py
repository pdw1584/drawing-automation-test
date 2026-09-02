import base64
import fitz

def png_data(pixmap: fitz.Pixmap) -> str:
    encoded = base64.b64encode(pixmap.tobytes("png")).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def changed_tiles(a: fitz.Pixmap, b: fitz.Pixmap, tile: int = 24) -> list[dict]:
    """PDF 두 페이지를 작은 타일로 비교해 변경 영역 후보를 반환한다.

    픽셀 하나마다 결과를 만들면 노이즈와 결과 수가 폭증하므로 타일 단위 차이 비율을
    계산한 뒤 인접한 변경 타일은 클라이언트가 표시할 수 있는 사각형으로 사용한다.
    """
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
