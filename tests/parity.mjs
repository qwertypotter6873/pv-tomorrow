// 파이썬(학습)과 자바스크립트(서비스)의 계산이 같은지 확인한다.
// 노트북이 저장한 표본(원자료 날씨 → 특성 → 예측 발전량)을 웹 코드로 다시 계산해 비교한다.
//
// 실행: (tests 폴더에서) npm install && node parity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';

import { buildDayFeatures } from '../web/js/features.js';
import { createPredictor, predictDay } from '../web/js/forecast.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'web/model/meta.json'), 'utf8'));
const { samples } = JSON.parse(fs.readFileSync(path.join(root, 'tests/parity_samples.json'), 'utf8'));

ort.env.wasm.numThreads = 1;
const predictor = await createPredictor(ort, meta, async (file) => fs.readFileSync(path.join(root, 'web/model', file)));

let worstFeature = 0;
let worstKwh = 0;
let failed = false;
for (const s of samples) {
  const plant = { lat: s.plant.lat, lon: s.plant.lon, capacityKw: s.plant.capacity_kw, effKw: s.plant.eff_kw ?? undefined };
  const { rows, daylight } = buildDayFeatures(plant.lat, plant.lon, s.date, s.weather, meta.features);

  // 1) 낮 시간으로 판정한 시각이 같은가
  const hours = daylight.map((d, i) => (d ? i + 1 : 0)).filter(Boolean);
  if (JSON.stringify(hours) !== JSON.stringify(s.hours)) {
    console.error(`[실패] ${s.plant.name} ${s.date}: 낮 시간 판정이 다름`, hours, s.hours);
    failed = true;
    continue;
  }
  // 2) 특성 값이 같은가 (값 크기에 따라 상대 오차로 비교)
  let featureDiff = 0;
  s.hours.forEach((h, k) => {
    rows[h - 1].forEach((v, j) => {
      const want = s.features[k][j];
      featureDiff = Math.max(featureDiff, Math.abs(v - want) / Math.max(1, Math.abs(want)));
    });
  });
  // 3) 예측 발전량이 같은가
  const day = await predictDay(predictor, meta, plant, s.date, s.weather);
  let kwhDiff = 0;
  s.hours.forEach((h, k) => {
    kwhDiff = Math.max(kwhDiff, Math.abs(day.kwh[h - 1] - s.pred_kwh[k]));
  });
  const capacity = s.plant.capacity_kw;
  console.log(
    `${s.plant.name} ${s.date}: 낮 ${s.hours.length}시간 · 특성 최대 상대오차 ${featureDiff.toExponential(1)} · ` +
      `예측 최대 차이 ${kwhDiff.toFixed(4)} kWh (설비용량의 ${((kwhDiff / capacity) * 100).toFixed(4)}%)`,
  );
  worstFeature = Math.max(worstFeature, featureDiff);
  worstKwh = Math.max(worstKwh, kwhDiff / capacity);
}

if (failed || worstFeature > 1e-3 || worstKwh > 1e-3) {
  console.error('불일치: 학습 코드와 서비스 코드의 계산이 다릅니다.');
  process.exit(1);
}
console.log(`일치: 표본 ${samples.length}건에서 특성과 예측이 모두 허용 오차 안에 있습니다.`);
