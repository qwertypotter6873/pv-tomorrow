"""태양 위치와 대기권 밖 일사량 계산 (NOAA 간이식).

웹 서비스(web/solar.js)에도 같은 식을 그대로 옮겨 쓰므로, 여기 식을 바꾸면 그쪽도 함께 바꿔야 한다.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

SOLAR_CONSTANT = 1361.0  # W/m2


def solar_geometry(lat: np.ndarray, lon: np.ndarray, utc: pd.DatetimeIndex) -> dict[str, np.ndarray]:
    """위도·경도(도)와 UTC 시각으로 태양 고도의 사인값, 방위각, 대기권 밖 수평면 일사량을 구한다.

    반환값
    - cos_zenith: 태양 고도의 사인값(= 천정각의 코사인). 0 이하면 해가 지평선 아래.
    - azimuth: 방위각(도, 북=0, 동=90, 남=180)
    - extra_ghi: 대기가 없다고 가정한 수평면 일사량(W/m2). 0 이상.
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    doy = utc.day_of_year.to_numpy(dtype=float)
    hour = utc.hour.to_numpy(dtype=float) + utc.minute.to_numpy(dtype=float) / 60.0

    gamma = 2.0 * np.pi / 365.0 * (doy - 1.0 + (hour - 12.0) / 24.0)
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * np.cos(gamma)
        - 0.032077 * np.sin(gamma)
        - 0.014615 * np.cos(2 * gamma)
        - 0.040849 * np.sin(2 * gamma)
    )
    decl = (
        0.006918
        - 0.399912 * np.cos(gamma)
        + 0.070257 * np.sin(gamma)
        - 0.006758 * np.cos(2 * gamma)
        + 0.000907 * np.sin(2 * gamma)
        - 0.002697 * np.cos(3 * gamma)
        + 0.00148 * np.sin(3 * gamma)
    )
    true_solar_min = (hour * 60.0 + eqtime + 4.0 * lon) % 1440.0
    hour_angle = np.radians(true_solar_min / 4.0 - 180.0)
    lat_r = np.radians(lat)

    cos_zenith = np.sin(lat_r) * np.sin(decl) + np.cos(lat_r) * np.cos(decl) * np.cos(hour_angle)
    cos_zenith = np.clip(cos_zenith, -1.0, 1.0)
    zenith = np.arccos(cos_zenith)

    sin_zenith = np.maximum(np.sin(zenith), 1e-6)
    cos_az = (np.sin(decl) - np.sin(lat_r) * cos_zenith) / (np.cos(lat_r) * sin_zenith)
    az = np.degrees(np.arccos(np.clip(cos_az, -1.0, 1.0)))
    azimuth = np.where(hour_angle > 0, 360.0 - az, az)

    earth_sun = 1.0 + 0.033 * np.cos(2.0 * np.pi * doy / 365.0)
    extra_ghi = SOLAR_CONSTANT * earth_sun * np.maximum(cos_zenith, 0.0)
    return {"cos_zenith": cos_zenith, "azimuth": azimuth, "extra_ghi": extra_ghi}
