"""Open-Meteo Previous Runs API에서 발전소 위치별 '과거 시점의 예보'를 내려받는다.

- 출처: https://open-meteo.com (CC BY 4.0, 비상업 무료, API 키 없음)
- `<변수>_previous_day1` = 해당 시각을 24시간 전에 예보한 값(하루 전 예보),
  `<변수>_previous_day2` = 48시간 전 예보, 접미사 없는 값 = 가장 최근 예보.
- 무료 한도(분당 600·시간당 5,000·일 10,000 가중 호출)를 넘지 않도록 요청 사이에 쉰다.
- 결과: data/raw/weather/<위치키>_<요청이름>.csv.gz (이미 있으면 건너뛴다)

실행: python src/download_weather.py [--no-lead] [위치키 ...]
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "weather"
API = "https://previous-runs-api.open-meteo.com/v1/forecast"
START, END = "2024-01-01", "2026-02-28"

MODELS = ["jma_seamless", "ecmwf_ifs025", "icon_seamless"]
BASE_VARS = [
    "shortwave_radiation",  # 수평면 전일사량 GHI (W/m2, 직전 1시간 평균)
    "direct_radiation",
    "diffuse_radiation",
    "cloud_cover",  # 층별 운량(low/mid/high)은 과거 예보 이력에 값이 없어 뺐다
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "precipitation",
    "snowfall",
]
LEAD_VARS = ["shortwave_radiation", "direct_radiation", "diffuse_radiation", "cloud_cover", "temperature_2m"]

REQUESTS = {
    # 하루 전 예보: 세 기상 모델 × 9개 변수 (모델 학습의 주 입력)
    "d1": {"models": MODELS, "hourly": [f"{v}_previous_day1" for v in BASE_VARS]},
    # 예보 시점에 따른 차이를 보기 위한 보조 자료: 이틀 전 예보와 최신 예보 (JMA만)
    "lead": {
        "models": ["jma_seamless"],
        "hourly": [f"{v}_previous_day2" for v in LEAD_VARS] + ["shortwave_radiation"],
    },
}
PAUSE = {"d1": 45, "lead": 15}  # 요청 뒤 대기(초)


def loc_key(lat: float, lon: float) -> str:
    return f"{lat:.3f}_{lon:.3f}"


def fetch(lat: float, lon: float, spec: dict) -> pd.DataFrame:
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": ",".join(spec["hourly"]),
        "models": ",".join(spec["models"]),
        "start_date": START,
        "end_date": END,
        "timezone": "Asia/Seoul",
    }
    for attempt in range(6):
        try:
            resp = requests.get(API, params=params, timeout=180)
        except requests.exceptions.RequestException as exc:  # 응답 지연·연결 끊김은 잠시 뒤 다시 시도
            wait = 60 * (attempt + 1)
            print(f"    연결 오류 {type(exc).__name__} → {wait}초 뒤 재시도", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code == 200:
            body = resp.json()
            df = pd.DataFrame(body["hourly"])
            df.insert(0, "grid_lat", body.get("latitude"))
            df.insert(1, "grid_lon", body.get("longitude"))
            return df
        wait = 90 * (attempt + 1)
        print(f"    HTTP {resp.status_code}: {resp.text[:120]} → {wait}초 뒤 재시도", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"날씨 요청 실패: {lat},{lon}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    plants = pd.read_csv(ROOT / "data" / "plants.csv")
    plants = plants[plants["use"] == 1]
    locs = plants[["lat", "lon", "area"]].drop_duplicates(["lat", "lon"]).reset_index(drop=True)
    args = sys.argv[1:]
    only = {a for a in args if not a.startswith("--")}  # 위치키를 인자로 주면 그 위치만 받는다
    skip_lead = "--no-lead" in args  # 예보 시점 비교용 보조 자료는 건너뛴다(요청 한도 절약)
    print(f"위치 {len(locs)}곳, 기간 {START}~{END}")
    for i, row in locs.iterrows():
        key = loc_key(row.lat, row.lon)
        if only and key not in only:
            continue
        for name, spec in REQUESTS.items():
            if name == "lead" and skip_lead:
                continue
            path = OUT / f"{key}_{name}.csv.gz"
            if path.exists():
                continue
            df = fetch(row.lat, row.lon, spec)
            df.to_csv(path, index=False)
            print(f"  [{i + 1}/{len(locs)}] {row.area} {name}: {df.shape}", flush=True)
            time.sleep(PAUSE[name])
    print("완료")


if __name__ == "__main__":
    main()
