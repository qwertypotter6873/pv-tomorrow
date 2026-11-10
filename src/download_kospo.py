"""공공데이터포털에서 한국남부발전(주) 발전소별 태양광 발전실적 CSV를 내려받는다.

- 출처: https://www.data.go.kr (제공기관: 한국남부발전(주), 이용허락범위 제한 없음)
- 로그인·API 키 없이 받을 수 있는 파일데이터만 사용한다.
- 결과: data/raw/kospo/<데이터ID>.csv 와 data/raw/kospo/manifest.json

실행: python src/download_kospo.py
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests

BASE = "https://www.data.go.kr"
OUT = Path(__file__).resolve().parents[1] / "data" / "raw" / "kospo"
HEADERS = {"User-Agent": "Mozilla/5.0 (coursework data download)"}
KEYWORDS = ["한국남부발전 태양광 발전실적", "남부발전 태양광발전실적"]
PAUSE = 0.6  # 요청 간격(초). 공공 사이트에 부담을 주지 않기 위해 둔다.


def is_target(title: str) -> bool:
    """발전소 단위 '태양광 발전실적' 파일만 고른다."""
    t = title.replace(" ", "")
    return (
        "남부발전" in t
        and "태양광" in t
        and "발전실적" in t
        and "출자" not in t
        and "해외" not in t
    )


def search_ids(session: requests.Session) -> dict[str, str]:
    found: dict[str, str] = {}
    for kw in KEYWORDS:
        for page in range(1, 30):
            url = (
                f"{BASE}/tcs/dss/selectDataSetList.do?dType=FILE"
                f"&keyword={quote(kw)}&currentPage={page}&perPage=40"
            )
            text = session.get(url, timeout=40).text
            new = 0
            for m in re.finditer(r"/data/(\d+)/fileData\.do[^>]*>(.*?)</a>", text, re.S):
                title = html.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))
                title = re.sub(r"\s+", " ", title).strip()
                if title and is_target(title) and m.group(1) not in found:
                    found[m.group(1)] = title
                    new += 1
            time.sleep(PAUSE)
            if new == 0:
                break
    return found


def detail(session: requests.Session, data_id: str) -> dict:
    page_url = f"{BASE}/data/{data_id}/fileData.do"
    text = session.get(page_url, timeout=40).text
    title = re.search(r"<title>(.*?)</title>", text, re.S)
    title = html.unescape(title.group(1)).split("|")[0].strip() if title else ""
    call = re.search(r"fn_fileDataDown\('(\d+)',\s*'([^']+)'", text)
    plain = html.unescape(re.sub(r"<[^>]+>", " ", text))
    lic = re.search(r"이용허락범위 제한 없음|공공누리\s*제?\s*\d\s*유형", plain)
    return {
        "id": data_id,
        "title": title,
        "page_url": page_url,
        "detail_pk": call.group(2) if call else None,
        "license": lic.group(0).strip() if lic else None,
    }


def download(session: requests.Session, info: dict) -> dict:
    page_url = info["page_url"]
    meta = session.post(
        f"{BASE}/tcs/dss/selectFileDataDownload.do?recommendDataYn=Y",
        data={
            "publicDataPk": info["id"],
            "publicDataDetailPk": info["detail_pk"],
            "fileDetailSn": "1",
        },
        headers={"X-Requested-With": "XMLHttpRequest", "Referer": page_url},
        timeout=40,
    ).json()
    file_url = (
        f"{BASE}/cmm/cmm/fileDownload.do?atchFileId={meta['atchFileId']}"
        f"&fileDetailSn={meta.get('fileDetailSn') or 1}"
    )
    raw = session.get(file_url, headers={"Referer": page_url}, timeout=120).content
    path = OUT / f"{info['id']}.csv"
    path.write_bytes(raw)
    text = None
    for enc in ("cp949", "utf-8-sig"):
        try:
            text = raw.decode(enc)
            info["encoding"] = enc
            break
        except UnicodeDecodeError:
            continue
    lines = text.splitlines() if text else []
    info.update(
        file=path.name,
        bytes=len(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
        rows=max(len(lines) - 1, 0),
        header=lines[0] if lines else None,
        first_date=lines[1].split(",")[0] if len(lines) > 1 else None,
        last_date=lines[-1].split(",")[0] if len(lines) > 1 else None,
        downloaded_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    return info


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(HEADERS)
    ids = search_ids(session)
    print(f"대상 데이터셋 {len(ids)}건")
    manifest = []
    for data_id, title in sorted(ids.items()):
        try:
            info = detail(session, data_id)
            time.sleep(PAUSE)
            if not info["detail_pk"]:
                raise RuntimeError("다운로드 식별자를 찾지 못함")
            info = download(session, info)
            print(
                f"  {data_id} {info['title'][:38]:<38} rows={info['rows']:>5} "
                f"{info['first_date']}~{info['last_date']}"
            )
        except Exception as exc:  # 한 건이 실패해도 나머지는 계속 받는다.
            info = {"id": data_id, "title": title, "error": repr(exc)}
            print(f"  {data_id} 실패: {exc!r}")
        manifest.append(info)
        time.sleep(PAUSE)
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    ok = sum("error" not in m for m in manifest)
    print(f"완료: 성공 {ok}건 / 실패 {len(manifest) - ok}건 → {OUT}")


if __name__ == "__main__":
    main()
