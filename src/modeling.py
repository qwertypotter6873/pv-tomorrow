"""학습·평가 공통 함수: 유효 용량, 평가 지표, 기준 예측, GRU 모델과 학습 루프."""

from __future__ import annotations

import random
import time

import numpy as np
import pandas as pd
import torch
from torch import nn

SEED = 42
HOURS = 24


def set_seed(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


# ------------------------------------------------------------------ 목표값 정규화
def effective_capacity(fit_df: pd.DataFrame, q: float = 0.995) -> pd.Series:
    """발전소별 '유효 용량' = 학습에 쓰는 기간의 시간당 발전량 99.5백분위(kW).

    공식 설비용량은 같아도 노후·음영·인버터 용량에 따라 실제 최대 출력이 발전소마다 다르다
    (공식 용량의 34~93%). 모델은 날씨→'유효 용량 대비 출력 비율'을 배우고,
    발전소별 규모 차이는 이 값이 맡는다. 평가 구간 자료는 쓰지 않는다.
    """
    return fit_df.groupby("series_id")["gen_kwh"].quantile(q).rename("eff_kw")


def add_target(df: pd.DataFrame, eff: pd.Series, default_ratio: float) -> pd.DataFrame:
    """유효 용량과 목표값 y(= 발전량 / 유효 용량)를 붙인다.

    유효 용량을 모르는 발전소(학습에 없던 곳)는 공식 설비용량 × 학습 발전소들의 중앙 비율을 쓴다.
    """
    out = df.copy()
    out["eff_kw"] = out["series_id"].map(eff)
    unknown = out["eff_kw"].isna()
    out.loc[unknown, "eff_kw"] = out.loc[unknown, "capacity_kw"] * default_ratio
    out["y"] = (out["gen_kwh"] / out["eff_kw"]).clip(0, 1.3).astype("float32")
    return out


# ------------------------------------------------------------------ 평가 지표
def evaluate(df: pd.DataFrame, pred_kwh: np.ndarray) -> dict[str, float]:
    """시험 자료와 예측 발전량(kWh)으로 지표를 계산한다. 오차는 모두 공식 설비용량으로 나눈다."""
    cap = df["capacity_kw"].to_numpy(dtype=float)
    actual = df["gen_kwh"].to_numpy(dtype=float)
    err = (pred_kwh - actual) / cap
    abs_err = np.abs(err) * 100.0
    cf = actual / cap
    active = cf >= 0.10  # 예측제도에서 정산 대상이 되는 이용률 10% 이상 시간대
    return {
        "NMAE(%)": float(abs_err.mean()),
        "RMSE(%)": float(np.sqrt((err**2).mean()) * 100.0),
        "R2": float(1.0 - (err**2).sum() / ((cf - cf.mean()) ** 2).sum()),
        "NMAE_이용률10%↑(%)": float(abs_err[active].mean()),
        "오차6%이내_비율(%)": float((abs_err[active] <= 6.0).mean() * 100.0),
    }


def evaluate_portfolio(df: pd.DataFrame, pred_kwh: np.ndarray) -> dict[str, float]:
    """발전소들을 한 묶음(집합 자원)으로 합쳐서 본 오차율. 예측제도는 이 단위로 정산한다."""
    tmp = pd.DataFrame(
        {"ts": df["ts_end"].to_numpy(), "pred": pred_kwh, "actual": df["gen_kwh"].to_numpy(), "cap": df["capacity_kw"].to_numpy()}
    )
    agg = tmp.groupby("ts").sum()
    abs_err = (agg["pred"] - agg["actual"]).abs() / agg["cap"] * 100.0
    active = agg["actual"] / agg["cap"] >= 0.10
    return {
        "묶음 NMAE(%)": float(abs_err.mean()),
        "묶음 NMAE_이용률10%↑(%)": float(abs_err[active].mean()),
        "묶음 오차6%이내_비율(%)": float((abs_err[active] <= 6.0).mean() * 100.0),
    }


def persistence(df_all: pd.DataFrame, target: pd.DataFrame, days: int) -> np.ndarray:
    """기준 예측: 며칠 전 같은 시각의 실제 발전량을 그대로 쓴다. 자료가 없으면 NaN."""
    lookup = df_all.set_index(["series_id", "ts_end"])["gen_kwh"]
    idx = pd.MultiIndex.from_arrays([target["series_id"], target["ts_end"] - pd.Timedelta(days=days)])
    return lookup.reindex(idx).to_numpy(dtype=float)


# ------------------------------------------------------------------ GRU용 하루 단위 자료
class DayData:
    """(발전소, 날짜)마다 24시간 순서열로 묶은 자료. 밤·제외된 시간은 mask=0."""

    def __init__(self, df: pd.DataFrame, features: list[str], mean: np.ndarray, std: np.ndarray):
        df = df.sort_values(["series_id", "date", "hour"]).reset_index(drop=True)
        keys = df["series_id"].astype(str) + "|" + df["date"].dt.strftime("%Y-%m-%d")
        day_idx, uniques = pd.factorize(keys)
        n = len(uniques)
        pos = df["hour"].to_numpy(dtype=int) - 1
        x = np.zeros((n, HOURS, len(features)), dtype=np.float32)
        y = np.zeros((n, HOURS), dtype=np.float32)
        mask = np.zeros((n, HOURS), dtype=np.float32)
        scale = np.zeros((n, HOURS), dtype=np.float32)  # y 오차 → 설비용량 대비 오차로 바꾸는 계수
        x[day_idx, pos] = (df[features].to_numpy(dtype=np.float32) - mean) / std
        y[day_idx, pos] = df["y"].to_numpy(dtype=np.float32)
        mask[day_idx, pos] = 1.0
        scale[day_idx, pos] = (df["eff_kw"] / df["capacity_kw"]).to_numpy(dtype=np.float32)
        self.df, self.day_idx, self.pos = df, day_idx, pos
        self.x, self.y, self.mask, self.scale = map(torch.from_numpy, (x, y, mask, scale))

    def __len__(self) -> int:
        return self.x.shape[0]

    def to_rows(self, pred_seq: np.ndarray) -> np.ndarray:
        """[일수, 24] 예측을 원래 행 순서(self.df)의 1차원 배열로 되돌린다."""
        return pred_seq[self.day_idx, self.pos]


class DayGRU(nn.Module):
    """하루 24시간의 예보 순서열을 읽어 시간대별 출력 비율을 내는 양방향 GRU."""

    def __init__(self, n_features: int, hidden: int = 64, layers: int = 2, dropout: float = 0.1):
        super().__init__()
        self.embed = nn.Sequential(nn.Linear(n_features, hidden), nn.ReLU())
        self.gru = nn.GRU(hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=dropout)
        self.head = nn.Sequential(nn.Linear(2 * hidden, hidden), nn.ReLU(), nn.Linear(hidden, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # x: [배치, 24, 특성 수]
        out, _ = self.gru(self.embed(x))
        return self.head(out).squeeze(-1)  # [배치, 24]


def predict_gru(model: nn.Module, data: DayData, batch: int = 1024) -> np.ndarray:
    model.eval()
    chunks = []
    with torch.no_grad():
        for i in range(0, len(data), batch):
            chunks.append(model(data.x[i : i + batch]).clamp(min=0).numpy())
    return np.concatenate(chunks)


def train_gru(
    train: DayData,
    val: DayData | None,
    n_features: int,
    epochs: int = 40,
    lr: float = 2e-3,
    batch: int = 128,
    seed: int = SEED,
    verbose: bool = True,
    **model_kwargs,
) -> tuple[nn.Module, list[dict]]:
    """GRU를 처음부터 학습한다.

    학습률은 정해진 epoch 수에 맞춰 올렸다 내리고(OneCycle), 마지막 epoch의 가중치를 쓴다.
    조기 종료를 쓰지 않는 이유: 검증으로 epoch 수를 정한 뒤 학습+검증 자료로 다시 학습할 때
    똑같은 일정으로 재현할 수 있어야 하기 때문이다. val을 주면 epoch마다 검증 오차를 기록만 한다.
    """
    set_seed(seed)
    model = DayGRU(n_features, **model_kwargs)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=lr, total_steps=epochs * int(np.ceil(len(train) / batch))
    )
    history = []
    generator = torch.Generator().manual_seed(seed)
    for epoch in range(1, epochs + 1):
        started = time.time()
        model.train()
        order = torch.randperm(len(train), generator=generator)
        total, weight = 0.0, 0.0
        for i in range(0, len(train), batch):
            idx = order[i : i + batch]
            pred = model(train.x[idx])
            m = train.mask[idx]
            # 설비용량 대비 절대 오차(평가 지표와 같은 단위)를 낮 시간에 대해서만 평균한다.
            loss = ((pred - train.y[idx]).abs() * train.scale[idx] * m).sum() / m.sum()
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            total += loss.item() * m.sum().item()
            weight += m.sum().item()
        row = {"epoch": epoch, "train_NMAE(%)": 100 * total / weight, "초": time.time() - started}
        if val is not None:
            pred = torch.from_numpy(predict_gru(model, val))
            row["val_NMAE(%)"] = float(100 * ((pred - val.y).abs() * val.scale * val.mask).sum() / val.mask.sum())
        history.append(row)
        if verbose and (epoch == 1 or epoch % 5 == 0 or epoch == epochs):
            msg = f"  epoch {epoch:>2}/{epochs}  train {row['train_NMAE(%)']:.3f}%"
            if val is not None:
                msg += f"  val {row['val_NMAE(%)']:.3f}%"
            print(msg + f"  ({row['초']:.1f}s)")
    return model, history
