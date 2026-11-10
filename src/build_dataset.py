"""발전실적(파일 형식 2종)과 하루 전 날씨 예보를 묶어 시간 단위 학습용 표를 만든다.

입력
- data/plants.csv              발전소 목록(좌표, 공식 설비용량, 사용 여부)
- data/raw/kospo/*.csv         한국남부발전 발전소별 시간대별 발전실적
- data/raw/weather/*_d1.csv.gz Open-Meteo 하루 전 예보 이력

출력
- data/processed/hourly.parquet   정제·결합·분할까지 끝난 표
- data/processed/prep_report.json 전처리 단계별 전·후 건수(README·노트북의 전후 비교에 사용)

실행: python src/build_dataset.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from solar import solar_geometry

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"

SEED = 42
# 세 기상 모델의 하루 전 예보가 모두 있는 첫날(ECMWF 일사량이 2024-03-07부터 제공됨)
PERIOD_START = "2024-03-08"
PERIOD_END = "2026-02-28"
TRAIN_END = "2024-12-31"  # 학습: 2024-03-08 ~ 2024-12-31
VAL_END = "2025-04-30"  # 검증: 2025-01-01 ~ 2025-04-30, 시험: 2025-05-01 ~ 2026-02-28
N_HOLDOUT_SITES = {"육지": 3, "제주": 1}  # 학습에서 통째로 뺄 '처음 보는 발전소' 위치 수

MODELS = ["jma_seamless", "ecmwf_ifs025", "icon_seamless"]
SHORT = {"jma_seamless": "jma", "ecmwf_ifs025": "ecmwf", "icon_seamless": "icon"}
WVARS = {
    "shortwave_radiation": "ghi",
    "direct_radiation": "dir",
    "diffuse_radiation": "dif",
    "cloud_cover": "cloud",
    "temperature_2m": "temp",
    "relative_humidity_2m": "rh",
    "wind_speed_10m": "wind",
    "precipitation": "precip",
    "snowfall": "snow",
}
CAPACITY_MISMATCH = 1.05  # 99.9백분위 출력이 공식 설비용량의 이 배수를 넘으면 용량 정보 불일치로 본다
MIN_DAYS = 300  # 정제 후 남은 날이 이보다 적은 발전소는 제외


def site_key(lat: float, lon: float) -> str:
    return f"{lat:.3f}_{lon:.3f}"


# ---------------------------------------------------------------- 1. 발전실적 읽기
def hour_columns(columns) -> dict[str, int]:
    """시간 열 이름을 '끝나는 시각'(1~24)으로 바꾼다. 형식: '1'..'24' 또는 '0-1시 발전량(kWh)'."""
    found = {}
    for col in columns:
        name = str(col).strip()
        if re.fullmatch(r"\d{1,2}", name):
            found[col] = int(name)
        else:
            m = re.match(r"^(\d{1,2})-(\d{1,2})시", name)
            if m:
                found[col] = int(m.group(2))
    return found


def read_generation(plants: pd.DataFrame, manifest: dict) -> pd.DataFrame:
    """발전소·호기별 일 단위 넓은 표를 (발전소, 날짜, 시각) 긴 표로 바꾼다."""
    frames = []
    for data_id, group in plants.groupby("data_id"):
        meta = manifest[str(data_id)]
        df = pd.read_csv(RAW / "kospo" / meta["file"], encoding=meta["encoding"])
        hcols = hour_columns(df.columns)
        if len(hcols) != 24:
            raise ValueError(f"{data_id}: 시간 열이 24개가 아님 ({len(hcols)}개)")
        date_col, unit_col = df.columns[0], df.columns[1]
        df["date"] = pd.to_datetime(df[date_col], errors="coerce")
        df = df[df["date"].notna()]
        for plant in group.itertuples():
            part = df[df[unit_col].astype(str).str.strip() == str(plant.unit)] if len(group) > 1 else df
            long = part.melt(id_vars="date", value_vars=list(hcols), var_name="col", value_name="gen_kwh")
            long["hour"] = long["col"].map(hcols).astype("int8")
            long["gen_kwh"] = pd.to_numeric(long["gen_kwh"], errors="coerce")
            long["series_id"] = plant.series_id
            frames.append(long[["series_id", "date", "hour", "gen_kwh"]])
    gen = pd.concat(frames, ignore_index=True)
    return gen[(gen["date"] >= PERIOD_START) & (gen["date"] <= PERIOD_END)].reset_index(drop=True)


# ---------------------------------------------------------------- 2. 날씨 읽기
def read_weather(sites: pd.DataFrame) -> pd.DataFrame:
    frames = []
    for site in sites.itertuples():
        path = RAW / "weather" / f"{site.site}_d1.csv.gz"
        if not path.exists():
            print(f"  (날씨 파일 없음: {site.site} — 이 위치는 건너뜀)")
            continue
        w = pd.read_csv(path)
        out = pd.DataFrame({"site": site.site, "ts_end": pd.to_datetime(w["time"])})
        for model in MODELS:
            for var, short in WVARS.items():
                col = f"{var}_previous_day1_{model}"
                if col in w.columns and w[col].notna().any():
                    out[f"{short}_{SHORT[model]}"] = w[col].to_numpy(dtype="float32")
        frames.append(out)
    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------- 3. 파생 변수
def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """태양 위치와 예보값에서 파생 변수를 만든다. 모두 서비스 시점에도 계산할 수 있는 값이다."""
    # 발전량·일사량 모두 '직전 1시간' 값이므로 태양 위치는 그 시간대의 가운데 시각으로 계산한다.
    mid_utc = pd.DatetimeIndex(df["ts_end"] - pd.Timedelta(minutes=30)).tz_localize("Asia/Seoul").tz_convert("UTC")
    geo = solar_geometry(df["lat"].to_numpy(), df["lon"].to_numpy(), mid_utc)
    df["cos_zenith"] = geo["cos_zenith"].astype("float32")
    df["azimuth"] = geo["azimuth"].astype("float32")
    df["extra_ghi"] = geo["extra_ghi"].astype("float32")

    doy = df["ts_end"].dt.day_of_year.to_numpy()
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25).astype("float32")
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25).astype("float32")

    ghi_cols = [f"ghi_{SHORT[m]}" for m in MODELS]
    for m in MODELS:
        s = SHORT[m]
        # 맑음 지수: 예보 일사량 / 대기권 밖 일사량. 해가 낮을 때 분모가 작아 튀므로 0~1.2로 자른다.
        kt = df[f"ghi_{s}"] / df["extra_ghi"].clip(lower=50.0)
        df[f"kt_{s}"] = kt.clip(0, 1.2).astype("float32")
    df["ghi_mean"] = df[ghi_cols].mean(axis=1).astype("float32")
    df["ghi_std"] = df[ghi_cols].std(axis=1).astype("float32")  # 모델 간 불일치 = 예보 불확실성
    df["ghi_min"] = df[ghi_cols].min(axis=1).astype("float32")
    df["ghi_max"] = df[ghi_cols].max(axis=1).astype("float32")
    df["cloud_mean"] = df[[f"cloud_{SHORT[m]}" for m in MODELS]].mean(axis=1).astype("float32")
    df["kt_mean"] = df[[f"kt_{SHORT[m]}" for m in MODELS]].mean(axis=1).astype("float32")
    return df


FEATURES = (
    [f"{v}_{SHORT[m]}" for m in MODELS for v in ["ghi", "dir", "dif", "cloud", "temp", "rh", "wind", "precip", "kt"]]
    + ["snow_jma", "snow_icon"]
    + ["ghi_mean", "ghi_std", "ghi_min", "ghi_max", "cloud_mean", "kt_mean"]
    + ["cos_zenith", "azimuth", "extra_ghi", "doy_sin", "doy_cos"]
)


# ---------------------------------------------------------------- 4. 전체 흐름
def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    report: dict = {"seed": SEED, "period": [PERIOD_START, PERIOD_END], "steps": []}

    def log(step: str, before: int, after: int, note: str = "") -> None:
        report["steps"].append({"step": step, "before": int(before), "after": int(after), "note": note})
        print(f"  {step:<34} {before:>9,} → {after:>9,}  {note}")

    plants_all = pd.read_csv(ROOT / "data" / "plants.csv", dtype={"data_id": str})
    plants = plants_all[plants_all["use"] == 1].copy()
    plants["site"] = [site_key(a, b) for a, b in zip(plants["lat"], plants["lon"])]
    manifest = {m["id"]: m for m in json.loads((RAW / "kospo" / "manifest.json").read_text(encoding="utf-8"))}
    report["plants_listed"] = int(len(plants_all))
    report["plants_excluded_manual"] = plants_all.loc[plants_all["use"] == 0, ["name", "note"]].to_dict("records")

    # --- 1) 형식 통일: 넓은 표(하루 한 줄, 24개 시간 열) → 긴 표(한 시간 한 줄)
    gen = read_generation(plants, manifest)
    print(f"발전실적: 발전소·호기 {gen['series_id'].nunique()}개, 시간 단위 {len(gen):,}행")
    n0 = len(gen)
    gen = gen.drop_duplicates(["series_id", "date", "hour"], keep="first")
    log("① 같은 날짜가 두 번 나온 행 제거", n0, len(gen))

    gen = gen.merge(plants[["series_id", "name", "region", "site", "lat", "lon", "capacity_kw"]], on="series_id")
    # 시간 열 h는 (h-1)시~h시 구간의 발전량이다. 24시는 다음 날 0시가 된다.
    gen["ts_end"] = gen["date"] + pd.to_timedelta(gen["hour"].astype(int), unit="h")

    # --- 2) 값 오류: 결측·음수
    bad = gen["gen_kwh"].isna() | (gen["gen_kwh"] < 0)
    n0 = len(gen)
    gen = gen[~bad]
    log("② 결측·음수 발전량 제거", n0, len(gen))

    # --- 3) 설비용량 정보가 실적과 맞지 않는 발전소 제외
    p999 = gen.groupby("series_id")["gen_kwh"].quantile(0.999)
    ratio = (p999 / plants.set_index("series_id")["capacity_kw"]).dropna()
    mismatch = ratio[ratio > CAPACITY_MISMATCH]
    report["capacity_ratio"] = ratio.round(3).to_dict()
    report["plants_excluded_capacity"] = {
        plants.set_index("series_id").loc[k, "name"]: round(float(v), 2) for k, v in mismatch.items()
    }
    n0 = len(gen)
    gen = gen[~gen["series_id"].isin(mismatch.index)]
    log("③ 설비용량 불일치 발전소 제외", n0, len(gen), f"{len(mismatch)}곳: {', '.join(report['plants_excluded_capacity'])}")

    # --- 4) 정지일 제외: 하루 발전량이 0이거나 그 발전소 평소(중앙값)의 2% 미만인 날
    daily = gen.groupby(["series_id", "date"])["gen_kwh"].sum().rename("day_kwh").reset_index()
    median = daily[daily["day_kwh"] > 0].groupby("series_id")["day_kwh"].median().rename("median_kwh")
    daily = daily.merge(median, on="series_id")
    daily["outage"] = daily["day_kwh"] < 0.02 * daily["median_kwh"]
    report["outage_days_by_series"] = daily.groupby("series_id")["outage"].sum().astype(int).to_dict()
    n0 = len(gen)
    gen = gen.merge(daily[["series_id", "date", "outage"]], on=["series_id", "date"])
    gen = gen[~gen["outage"]].drop(columns="outage")
    log("④ 정지일(하루 발전량 ≈ 0) 제외", n0, len(gen), f"발전소·일 {int(daily['outage'].sum()):,}건")

    # --- 5) 날씨 결합
    sites = plants.drop_duplicates("site")[["site", "lat", "lon"]]
    weather = read_weather(sites)
    n0 = len(gen)
    df = gen.merge(weather, on=["site", "ts_end"], how="left")
    df = add_features(df)
    missing = df[FEATURES].isna().any(axis=1)
    report["weather_missing_rows"] = int(missing.sum())
    df = df[~missing]
    log("⑤ 날씨 예보가 비어 있는 시간 제외", n0, len(df))

    # --- 6) 밤 시간 제외: 해가 지평선 아래인 시간은 발전량이 0으로 정해져 있어 예측 대상이 아니다
    night = df["cos_zenith"] <= 0
    report["night_rows_with_generation"] = int((night & (df["gen_kwh"] > 0)).sum())
    report["night_energy_share"] = float(df.loc[night, "gen_kwh"].sum() / df["gen_kwh"].sum())
    n0 = len(df)
    df = df[~night]
    log("⑥ 밤 시간(태양 고도 ≤ 0°) 제외", n0, len(df), f"밤 시간 발전량 비중 {report['night_energy_share']:.4%}")

    # --- 7) 남은 날이 너무 적은 발전소 제외
    days = df.groupby("series_id")["date"].nunique()
    few = days[days < MIN_DAYS]
    report["plants_excluded_few_days"] = {plants.set_index("series_id").loc[k, "name"]: int(v) for k, v in few.items()}
    n0 = len(df)
    df = df[~df["series_id"].isin(few.index)]
    log(f"⑦ 남은 날 {MIN_DAYS}일 미만 발전소 제외", n0, len(df), f"{len(few)}곳")

    # --- 8) 설비이용률로 정규화: 발전소마다 다른 규모(40kW~2.6MW)를 0~1 범위로 맞춘다
    df["cf"] = (df["gen_kwh"] / df["capacity_kw"]).astype("float32")

    # --- 9) 분할: 시간 순 + '처음 보는 발전소' 위치 따로 떼기
    rng = np.random.default_rng(SEED)
    site_region = df.drop_duplicates("site").set_index("site")["region"].sort_index()
    holdout = []
    for region, k in N_HOLDOUT_SITES.items():
        pool = site_region[site_region == region].index.to_numpy()
        if len(pool) <= k:  # 날씨를 일부만 받은 상태에서 시험 실행할 때만 해당
            print(f"  ({region} 위치가 {len(pool)}곳뿐이라 '처음 보는 발전소'를 떼지 않음)")
            continue
        holdout += list(rng.choice(pool, size=k, replace=False))
    df["new_site"] = df["site"].isin(holdout)
    period = np.where(df["date"] <= TRAIN_END, "train", np.where(df["date"] <= VAL_END, "val", "test"))
    df["period"] = period
    # 처음 보는 발전소는 학습·검증에 쓰지 않고 시험 기간 자료만 평가에 쓴다.
    df["split"] = np.where(
        df["new_site"], np.where(period == "test", "test_new_site", "unused"), period
    )
    report["holdout_sites"] = {
        s: sorted(df.loc[df["site"] == s, "name"].unique().tolist()) for s in holdout
    }
    report["split_rows"] = df["split"].value_counts().to_dict()
    report["split_days"] = {
        "train": [PERIOD_START, TRAIN_END],
        "val": ["2025-01-01", VAL_END],
        "test": ["2025-05-01", PERIOD_END],
    }
    report["series_final"] = int(df["series_id"].nunique())
    report["sites_final"] = int(df["site"].nunique())
    report["features"] = FEATURES

    cols = (
        ["series_id", "name", "region", "site", "lat", "lon", "capacity_kw", "date", "hour", "ts_end"]
        + ["gen_kwh", "cf", "period", "new_site", "split"]
        + FEATURES
    )
    df = df[cols].sort_values(["series_id", "ts_end"]).reset_index(drop=True)
    df.to_parquet(OUT / "hourly.parquet", index=False)
    (OUT / "prep_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n최종: 발전소·호기 {report['series_final']}개, 위치 {report['sites_final']}곳, {len(df):,}행, 특성 {len(FEATURES)}개")
    print("분할별 행 수:", report["split_rows"])
    print("처음 보는 발전소:", report["holdout_sites"])


if __name__ == "__main__":
    main()
