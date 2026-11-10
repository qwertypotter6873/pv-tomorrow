// 날씨 예보 받기(Open-Meteo)와 학습한 모델(ONNX) 추론.
// 브라우저와 Node(검증 스크립트) 양쪽에서 쓰도록 onnxruntime 객체는 밖에서 넘겨받는다.

import { WEATHER_MODELS, WEATHER_VARS, buildDayFeatures } from './features.js';

const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const PAST_API = 'https://previous-runs-api.open-meteo.com/v1/forecast';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 사용자에게 보여줄 수 있는 오류. message 는 무엇이 잘못됐고 어떻게 하면 되는지를 담는다. */
export class ForecastError extends Error {}

async function requestWeather(api, lat, lon, dateStr, suffix) {
  const hourly = WEATHER_VARS.map((v) => `${v.api}${suffix}`).join(',');
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly,
    models: WEATHER_MODELS.map((m) => m.id).join(','),
    timezone: 'Asia/Seoul',
    start_date: dateStr,
    end_date: addDays(dateStr, 1),
  });

  let response;
  try {
    response = await fetch(`${api}?${params}`);
  } catch {
    throw new ForecastError('날씨 예보 서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.');
  }
  if (response.status === 429) {
    throw new ForecastError('날씨 예보 서버의 요청 한도를 넘었습니다. 1분쯤 뒤에 다시 시도하세요.');
  }
  if (!response.ok) {
    let reason = '';
    try {
      reason = (await response.json()).reason || '';
    } catch {
      /* 본문이 JSON 이 아니면 사유 없이 안내한다 */
    }
    throw new ForecastError(`날씨 예보를 받지 못했습니다(${response.status}). ${reason}`.trim());
  }
  const body = await response.json();
  const times = body.hourly?.time || [];
  const first = times.indexOf(`${dateStr}T01:00`);
  if (first < 0 || first + 24 > times.length) {
    throw new ForecastError('이 날짜의 예보가 응답에 없습니다. 다른 날짜를 선택하세요.');
  }

  const weather = {};
  for (const v of WEATHER_VARS) {
    for (const m of WEATHER_MODELS) {
      const series = body.hourly[`${v.api}${suffix}_${m.id}`];
      weather[`${v.short}_${m.short}`] = series ? series.slice(first, first + 24) : new Array(24).fill(null);
    }
  }
  const hasRadiation = WEATHER_MODELS.some((m) => weather[`ghi_${m.short}`].some((x) => x !== null));
  if (!hasRadiation) {
    throw new ForecastError('이 날짜에는 아직 일사량 예보가 없습니다. 오늘부터 3일 이내의 날짜를 선택하세요.');
  }
  return { weather, gridLat: body.latitude, gridLon: body.longitude };
}

/** 앞으로 올 날짜(내일 등)의 최신 예보. */
export function fetchForecast(lat, lon, dateStr) {
  return requestWeather(FORECAST_API, lat, lon, dateStr, '');
}

/** 지난 날짜에 대해 '그 전날 발표됐던 예보'. 학습에 쓴 자료와 같은 종류다. */
export function fetchPastForecast(lat, lon, dateStr) {
  return requestWeather(PAST_API, lat, lon, dateStr, '_previous_day1');
}

/**
 * 모델 파일을 읽어 예측기를 만든다.
 * @param {object} ort onnxruntime-web 모듈
 * @param {object} meta model/meta.json 내용
 * @param {(file:string)=>Promise<ArrayBuffer|Uint8Array>} loadBytes 모델 파일을 읽는 함수
 */
export async function createPredictor(ort, meta, loadBytes) {
  const loaded = [];
  for (const spec of meta.models) {
    const bytes = await loadBytes(spec.file);
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
    loaded.push({ spec, session });
  }
  const nFeatures = meta.features.length;
  const totalWeight = meta.models.reduce((a, m) => a + m.weight, 0);

  async function runTabular({ session }, rows, hours) {
    const flat = new Float32Array(hours.length * nFeatures);
    hours.forEach((h, k) => flat.set(rows[h], k * nFeatures));
    const input = new ort.Tensor('float32', flat, [hours.length, nFeatures]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const values = out[session.outputNames[0]].data;
    const day = new Float32Array(24);
    hours.forEach((h, k) => {
      day[h] = values[k];
    });
    return day;
  }

  async function runSequence({ spec, session }, rows) {
    const flat = new Float32Array(24 * nFeatures); // 밤 시간은 0으로 둔다(학습 때와 같음)
    rows.forEach((row, h) => {
      if (!row) return;
      for (let j = 0; j < nFeatures; j++) flat[h * nFeatures + j] = (row[j] - spec.mean[j]) / spec.std[j];
    });
    const input = new ort.Tensor('float32', flat, [1, 24, nFeatures]);
    const out = await session.run({ [session.inputNames[0]]: input });
    return Float32Array.from(out[session.outputNames[0]].data);
  }

  return {
    /**
     * 하루치 출력 비율(유효 용량 대비, 0~yMax)을 계산한다. 밤 시간은 0.
     * @returns {Promise<Float32Array>} 길이 24
     */
    async predictRatio(rows, daylight) {
      const hours = daylight.map((d, h) => (d ? h : -1)).filter((h) => h >= 0);
      const result = new Float32Array(24);
      if (!hours.length) return result;
      for (const item of loaded) {
        const day = item.spec.kind === 'sequence' ? await runSequence(item, rows) : await runTabular(item, rows, hours);
        for (const h of hours) result[h] += (item.spec.weight / totalWeight) * day[h];
      }
      for (const h of hours) result[h] = Math.min(meta.y_max, Math.max(0, result[h]));
      return result;
    },
  };
}

/**
 * 한 발전소의 하루 발전량을 예측한다.
 * @param {object} predictor createPredictor 결과
 * @param {object} meta
 * @param {{lat:number, lon:number, capacityKw:number, effKw?:number}} plant effKw 가 없으면 설비용량 × 기본 성능 계수
 * @param {string} dateStr
 * @param {object} weather fetchForecast / fetchPastForecast 의 weather
 */
export async function predictDay(predictor, meta, plant, dateStr, weather) {
  const { rows, daylight, filled, geometry } = buildDayFeatures(plant.lat, plant.lon, dateStr, weather, meta.features);
  const ratio = await predictor.predictRatio(rows, daylight);
  const effKw = plant.effKw ?? plant.capacityKw * meta.default_ratio;
  const kwh = Array.from(ratio, (r) => r * effKw);
  const index = (name) => meta.features.indexOf(name);
  const pick = (name) => rows.map((row) => (row ? row[index(name)] : null));
  return {
    kwh,
    daylight,
    filled,
    geometry,
    totalKwh: kwh.reduce((a, b) => a + b, 0),
    cloud: pick('cloud_mean'),
    ghi: pick('ghi_mean'),
    ghiSpread: rows.map((row) => (row ? row[index('ghi_max')] - row[index('ghi_min')] : null)),
  };
}
