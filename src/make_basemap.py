"""지도 바탕(시·도 경계)을 만든다: Natural Earth 행정구역 자료에서 대한민국만 골라 단순화한다.

- 출처: Natural Earth 1:10m Admin 1 – States, Provinces (퍼블릭 도메인, https://www.naturalearthdata.com)
- 결과: web/data/korea.json — 시·도별 다각형(경도, 위도). 웹 지도와 노트북 그림이 같이 쓴다.
- 원본 GeoJSON(약 40MB)은 저장소에 넣지 않고 임시 폴더에 받는다.

실행: python src/make_basemap.py
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson"
TOLERANCE = 0.006  # 단순화 허용 오차(도). 약 600m
MIN_AREA = 0.0015  # 이보다 작은 섬(도 단위 넓이)은 뺀다. 약 15㎢


def simplify(points: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas–Peucker 단순화(반복문 구현)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        far, index = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            dist = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if dist > far:
                far, index = dist, i
        if far > tol and index > 0:
            keep[index] = True
            stack += [(a, index), (index, b)]
    return [p for p, k in zip(points, keep) if k]


def ring_area(ring: list[list[float]]) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "admin1.geojson"
        with requests.get(URL, stream=True, timeout=300) as response:
            response.raise_for_status()
            with open(path, "wb") as f:
                for chunk in response.iter_content(1 << 20):
                    f.write(chunk)
        print(f"원본 {path.stat().st_size / 1e6:.1f} MB")
        features = json.loads(path.read_text(encoding="utf-8"))["features"]

    provinces = []
    for feature in features:
        props = feature["properties"]
        if props.get("adm0_a3") != "KOR":
            continue
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        rings = []
        for polygon in polygons:
            outer = [[float(x), float(y)] for x, y in polygon[0]]  # 바깥 테두리만 쓴다
            if ring_area(outer) < MIN_AREA:
                continue
            ring = simplify(outer, TOLERANCE)
            if len(ring) >= 4:
                rings.append([[round(x, 3), round(y, 3)] for x, y in ring])
        if rings:
            provinces.append({"name": props.get("name_ko") or props.get("name_local") or props.get("name"), "name_en": props.get("name"), "polygons": rings})

    provinces.sort(key=lambda p: p["name_en"] or "")
    out = ROOT / "web" / "data" / "korea.json"
    out.write_text(
        json.dumps({"source": "Natural Earth 1:10m Admin 1 (public domain)", "provinces": provinces}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    points = sum(len(r) for p in provinces for r in p["polygons"])
    print(f"시·도 {len(provinces)}개, 다각형 {sum(len(p['polygons']) for p in provinces)}개, 점 {points:,}개 → {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB)")
    print(", ".join(p["name"] for p in provinces))


if __name__ == "__main__":
    main()
