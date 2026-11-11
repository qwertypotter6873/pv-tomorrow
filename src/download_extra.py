"""공공데이터포털에서 남부발전 외 기관의 시간대별 태양광 발전실적을 내려받는다.

| 폴더 | 데이터셋 | 내용 |
|---|---|---|
| data/raw/ewp  | 한국동서발전(주)_일자별지점별 태양광 발전량 데이터 (15099650) | 당진·동해·울산, 좌표·설비용량 포함, Wh |
| data/raw/khnp | 한국수력원자력(주)_기상정보를 융합한 한수원 태양광 시계열 발전정보 (15165984) | 발전기별 시간 단위 계량전력량(kWh), zip |
| data/raw/kdhc | 한국지역난방공사_(AI학습용)태양광 발전량 예측용 발전소 운영 및 기상 데이터 (15165728) | 지사별 인버터 누적 발전량(kWh), zip |

모두 이용허락범위 제한 없음. 받은 파일은 형식을 바꾸지 않고 그대로 저장한다.
실행: python src/download_extra.py
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

import download_kospo as dk

ROOT = Path(__file__).resolve().parents[1]
DATASETS = {
    "ewp": ("15099650", "csv"),
    "khnp": ("15165984", "zip"),
    "kdhc": ("15165728", "zip"),
}


def main() -> None:
    session = requests.Session()
    session.headers.update(dk.HEADERS)
    for source, (data_id, ext) in DATASETS.items():
        out = ROOT / "data" / "raw" / source
        out.mkdir(parents=True, exist_ok=True)
        info = dk.detail(session, data_id)
        meta = session.post(
            f"{dk.BASE}/tcs/dss/selectFileDataDownload.do?recommendDataYn=Y",
            data={"publicDataPk": data_id, "publicDataDetailPk": info["detail_pk"], "fileDetailSn": "1"},
            headers={"X-Requested-With": "XMLHttpRequest", "Referer": info["page_url"]},
            timeout=40,
        ).json()
        raw = session.get(
            f"{dk.BASE}/cmm/cmm/fileDownload.do?atchFileId={meta['atchFileId']}&fileDetailSn=1",
            headers={"Referer": info["page_url"]},
            timeout=600,
        ).content
        path = out / f"{data_id}.{ext}"
        path.write_bytes(raw)
        info.update(
            file=path.name,
            bytes=len(raw),
            sha256=hashlib.sha256(raw).hexdigest(),
            downloaded_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        (out / "manifest.json").write_text(json.dumps([info], ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{source}: {info['title'][:50]} → {path.relative_to(ROOT)} ({len(raw) / 1e6:.1f} MB)")
        time.sleep(dk.PAUSE)


if __name__ == "__main__":
    main()
