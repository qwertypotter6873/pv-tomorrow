// 날씨 예보 → 모델 입력 특성. 학습 코드 src/build_dataset.py 의 add_features 와 같은 계산이다.
// 특성의 순서와 이름은 model/meta.json 의 features 를 그대로 따른다.

import { solarGeometry } from './solar.js';

export const WEATHER_MODELS = [
  { id: 'jma_seamless', short: 'jma', label: '일본 기상청(JMA)' },
  { id: 'ecmwf_ifs025', short: 'ecmwf', label: '유럽중기예보센터(ECMWF)' },
  { id: 'icon_seamless', short: 'icon', label: '독일 기상청(ICON)' },
];

export const WEATHER_VARS = [
  { api: 'shortwave_radiation', short: 'ghi' },
  { api: 'direct_radiation', short: 'dir' },
  { api: 'diffuse_radiation', short: 'dif' },
  { api: 'cloud_cover', short: 'cloud' },
  { api: 'temperature_2m', short: 'temp' },
  { api: 'relative_humidity_2m', short: 'rh' },
  { api: 'wind_speed_10m', short: 'wind' },
  { api: 'precipitation', short: 'precip' },
  { api: 'snowfall', short: 'snow' },
];

const KST_OFFSET_MS = 9 * 3600 * 1000;

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 표본 표준편차(n-1로 나눔). pandas 의 std 와 같다. */
function sampleStd(values) {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/** 한국 시각 기준 연중 일수(1~366). tsEndMs 는 시간대가 끝나는 시각의 UTC 밀리초. */
function dayOfYearKST(tsEndMs) {
  const kst = new Date(tsEndMs + KST_OFFSET_MS);
  const start = Date.UTC(kst.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - start) / 86400000) + 1;
}

/**
 * 하루치(24시간) 특성 행렬을 만든다.
 * @param {number} lat
 * @param {number} lon
 * @param {string} dateStr 예측할 날짜 'YYYY-MM-DD' (한국 시각)
 * @param {Object<string, (number|null)[]>} weather 키 `${변수}_${모델}`(예: ghi_jma) → 24개 값.
 *        i번째 값은 (i)시~(i+1)시 구간의 값이다(끝나는 시각 i+1시).
 * @param {string[]} featureNames meta.json 의 특성 이름 순서
 * @returns {{rows:(Float32Array|null)[], daylight:boolean[], filled:number, geometry:object[]}}
 *          밤 시간의 rows 는 null. filled 는 비어 있어 다른 모델 값으로 메운 칸 수.
 */
export function buildDayFeatures(lat, lon, dateStr, weather, featureNames) {
  const dayStart = Date.parse(`${dateStr}T00:00:00+09:00`);
  const rows = [];
  const daylight = [];
  const geometry = [];
  let filled = 0;

  for (let i = 0; i < 24; i++) {
    const tsEnd = dayStart + (i + 1) * 3600000;
    const geo = solarGeometry(lat, lon, new Date(tsEnd - 30 * 60000)); // 구간 가운데 시각
    geometry.push(geo);
    if (geo.cosZenith <= 0) {
      rows.push(null);
      daylight.push(false);
      continue;
    }

    const f = {};
    for (const v of WEATHER_VARS) {
      const got = WEATHER_MODELS.map((m) => weather[`${v.short}_${m.short}`]?.[i]);
      const present = got.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
      WEATHER_MODELS.forEach((m, k) => {
        let value = got[k];
        if (value === null || value === undefined || !Number.isFinite(value)) {
          // 한 기상 모델의 값이 비면 나머지 모델의 평균으로 메운다(강설은 0).
          value = present.length ? mean(present) : v.short === 'snow' ? 0 : NaN;
          if (v.short !== 'snow' || m.short !== 'ecmwf') filled += 1;
        }
        f[`${v.short}_${m.short}`] = value;
      });
    }

    const denom = Math.max(geo.extraGhi, 50);
    const ghis = WEATHER_MODELS.map((m) => f[`ghi_${m.short}`]);
    const kts = ghis.map((g) => Math.min(1.2, Math.max(0, g / denom)));
    WEATHER_MODELS.forEach((m, k) => {
      f[`kt_${m.short}`] = kts[k];
    });
    f.ghi_mean = mean(ghis);
    f.ghi_std = sampleStd(ghis);
    f.ghi_min = Math.min(...ghis);
    f.ghi_max = Math.max(...ghis);
    f.cloud_mean = mean(WEATHER_MODELS.map((m) => f[`cloud_${m.short}`]));
    f.kt_mean = mean(kts);
    f.cos_zenith = geo.cosZenith;
    f.azimuth = geo.azimuth;
    f.extra_ghi = geo.extraGhi;
    const doy = dayOfYearKST(tsEnd);
    f.doy_sin = Math.sin((2 * Math.PI * doy) / 365.25);
    f.doy_cos = Math.cos((2 * Math.PI * doy) / 365.25);

    const row = new Float32Array(featureNames.length);
    featureNames.forEach((name, j) => {
      row[j] = f[name];
    });
    if (row.some((x) => !Number.isFinite(x))) {
      throw new Error(`${i + 1}시 예보에 비어 있는 값이 있어 계산할 수 없습니다.`);
    }
    rows.push(row);
    daylight.push(true);
  }
  return { rows, daylight, filled, geometry };
}
