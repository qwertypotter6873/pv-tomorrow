// 화면 동작: 입력 검증 → 날씨 예보 받기 → 학습한 모델로 추론 → 결과 표시.

import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { ForecastError, createPredictor, fetchForecast, fetchPastForecast, predictDay } from './forecast.js';
import { formatKwh, renderDayChart } from './chart.js';
import { renderKoreaMap } from './map.js';
import { sunriseSunset } from './solar.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

const REGIONS = [
  ['서울', 37.5665, 126.978], ['인천', 37.4563, 126.7052], ['수원', 37.2636, 127.0286], ['춘천', 37.8813, 127.7298],
  ['강릉', 37.7519, 128.8761], ['청주', 36.6424, 127.489], ['대전', 36.3504, 127.3845], ['세종', 36.48, 127.289],
  ['전주', 35.8242, 127.148], ['광주', 35.1595, 126.8526], ['목포', 34.8118, 126.3922], ['대구', 35.8714, 128.6014],
  ['포항', 36.019, 129.3435], ['울산', 35.5384, 129.3114], ['부산', 35.1796, 129.0756], ['창원', 35.228, 128.6811],
  ['제주', 33.4996, 126.5312], ['서귀포', 33.2541, 126.56],
];
const LIMITS = { lat: [33, 39], lon: [124, 132], capacity: [0.1, 1000000], ratio: [0.3, 1.1] };
const STORAGE_KEY = 'pv-tomorrow-inputs';
const fmt = (digits) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const $ = (id) => document.getElementById(id);

let meta = null;
let predictor = null;
let actuals = null;
let baseMap = null;
let lastForecast = null;
let lastVerify = null;

// ------------------------------------------------------------ 공통 도구
function node(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined));
  return n;
}

function kstDate(offsetDays = 0) {
  const now = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
  return now.toISOString().slice(0, 10);
}

function dateLabel(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
  return `${year}년 ${month}월 ${day}일(${weekday})`;
}

function clock(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function statusIcon(ok) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const circle = document.createElementNS(svg.namespaceURI, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '8');
  circle.setAttribute('fill', ok ? 'var(--good)' : 'var(--critical)');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ok ? 'M4.4 8.3l2.4 2.4 4.8-5' : 'M5 5l6 6M11 5l-6 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(circle, path);
  return svg;
}

function showError(id, message) {
  const box = $(id);
  box.textContent = message || '';
  box.hidden = !message;
}

/** 숫자 입력을 읽고 범위를 확인한다. 잘못되면 설명과 함께 예외를 던진다. */
function readNumber(id, name, [min, max], unit = '') {
  const input = $(id);
  const raw = input.value.trim().replace(',', '.');
  const value = Number(raw);
  const ok = raw !== '' && Number.isFinite(value) && value >= min && value <= max;
  input.setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (!ok) {
    input.focus();
    const number = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
    const range = `${number.format(min)}${unit}~${number.format(max)}${unit}`;
    throw new ForecastError(raw === '' ? `${name} 값을 입력하세요.` : `${name} 값은 ${range} 사이의 숫자로 입력하세요. 입력한 값: ${input.value}`);
  }
  return value;
}

function facts(items) {
  const dl = node('dl', { class: 'facts' });
  for (const [term, value] of items) {
    const dd = node('dd');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value;
    dl.append(node('div', {}, node('dt', { text: term }), dd));
  }
  return dl;
}

function legend(series) {
  const ul = node('ul', { class: 'legend' });
  for (const s of series) {
    const key = node('span', { class: s.dot ? 'key dot' : 'key' });
    key.style.background = s.color;
    ul.append(node('li', {}, key, node('span', { text: s.name })));
  }
  return ul;
}

function tableView(columns, rows, fileName) {
  const table = node('table');
  table.append(node('thead', {}, node('tr', {}, ...columns.map((c) => node('th', { scope: 'col', text: c })))));
  const body = node('tbody');
  for (const row of rows) body.append(node('tr', {}, ...row.map((c) => node('td', { text: c }))));
  table.append(body);
  const save = node('button', { type: 'button', class: 'text-button', text: '표를 CSV 파일로 저장' });
  save.addEventListener('click', () => {
    const csv = [columns, ...rows].map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
    const link = node('a', { href: URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv' })), download: fileName });
    link.click();
    URL.revokeObjectURL(link.href);
  });
  return node(
    'details',
    { class: 'table-view' },
    node('summary', { text: '시간대별 표 보기' }),
    node('p', { class: 'table-actions' }, save),
    node('div', { class: 'table-scroll' }, table),
  );
}

function chartBlock(title, series, drawData) {
  const host = node('div');
  const block = node('div', { class: 'chart-block' }, node('h3', { class: 'chart-title', text: title }));
  if (series.length > 1) block.append(legend(series));
  block.append(host);
  const draw = () => renderDayChart(host, { ...drawData, series });
  return { block, draw };
}

/** 낮 시간 동안 기상 모델 3종의 일사량 예보가 서로 얼마나 다른지(평균 일사량 대비 비율). */
function spreadOf(day) {
  let spread = 0;
  let total = 0;
  day.daylight.forEach((isDay, i) => {
    if (!isDay) return;
    spread += day.ghiSpread[i];
    total += day.ghi[i];
  });
  return total > 0 ? spread / total : 0;
}

function spreadText(value) {
  const bin = meta.spread_bins.find((b) => value <= b.upto) || meta.spread_bins[meta.spread_bins.length - 1];
  return `${bin.label} (이런 날의 평균 오차율 ${fmt(1).format(bin.nmae)}%)`;
}

// ------------------------------------------------------------ 주소로 위치 찾기
const GEOCODE_API = 'https://nominatim.openstreetmap.org/search';

/** 검색 결과의 이름을 한국식 순서(넓은 곳 → 좁은 곳)로 바꾼다. 나라 이름과 우편번호는 뺀다. */
function koreanOrder(displayName) {
  return displayName
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== '대한민국' && !/^\d{5}$/.test(part))
    .reverse()
    .join(' ');
}

async function geocode(query) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'kr', 'accept-language': 'ko', limit: '5' });
  let response;
  try {
    response = await fetch(`${GEOCODE_API}?${params}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ForecastError('주소 검색 서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 지도에서 위치를 고르세요.');
  }
  if (response.status === 429 || response.status === 403) {
    throw new ForecastError('주소 검색 요청이 잠시 제한됐습니다. 조금 뒤에 다시 찾거나 지도에서 위치를 고르세요.');
  }
  if (!response.ok) throw new ForecastError(`주소 검색에 실패했습니다(${response.status}). 지도에서 위치를 고르세요.`);
  const list = await response.json();
  return list
    .map((item) => ({ lat: Number(item.lat), lon: Number(item.lon), name: koreanOrder(item.display_name || '') }))
    .filter((r) => r.lat >= LIMITS.lat[0] && r.lat <= LIMITS.lat[1] && r.lon >= LIMITS.lon[0] && r.lon <= LIMITS.lon[1]);
}

function applyLocation(result, fallback) {
  $('region').value = '';
  $('lat').value = result.lat.toFixed(4);
  $('lon').value = result.lon.toFixed(4);
  for (const id of ['lat', 'lon']) $(id).setAttribute('aria-invalid', 'false');
  $('address-results').hidden = true;
  const status = $('address-status');
  status.textContent = `찾은 위치: ${result.name}${fallback ? ` (입력한 주소 그대로는 없어 '${fallback}'로 찾음)` : ''}`;
  status.hidden = false;
  drawPickMap();
}

/** 두 지점 사이 거리(km). */
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function searchAddress() {
  showError('forecast-error', '');
  $('address-status').hidden = true;
  $('address-results').hidden = true;
  const query = $('address').value.trim().replace(/\s+/g, ' ');
  if (query.length < 2) {
    $('address').focus();
    throw new ForecastError('찾을 주소나 지명을 두 글자 이상 입력하세요.');
  }
  // 전체 주소로 못 찾으면 뒤쪽 단어를 하나씩 덜어 더 넓은 행정구역으로 다시 찾는다(최대 두 번).
  const words = query.split(' ');
  let results = [];
  let used = query;
  for (let cut = 0; cut <= Math.min(2, words.length - 1); cut++) {
    used = words.slice(0, words.length - cut).join(' ');
    if (cut) await new Promise((resolve) => setTimeout(resolve, 1100)); // 검색 서버 이용 규칙: 1초에 한 번 이하
    results = await geocode(used);
    if (results.length) break;
  }
  if (!results.length) {
    throw new ForecastError(`'${query}'의 위치를 찾지 못했습니다. 읍·면·동 이름까지만 넣어 다시 찾거나 지도에서 위치를 고르세요.`);
  }
  const fallback = used === query ? null : used;
  // 이름이 같은 결과는 하나만 남긴다
  results = results.filter((r, i) => results.findIndex((o) => o.name === r.name) === i);
  // 후보가 모두 2km 안에 있으면 고를 필요가 없다(날씨 예보 격자가 약 10km).
  if (results.every((r) => distanceKm(r, results[0]) < 2)) return applyLocation(results[0], fallback);

  const list = $('address-results');
  list.replaceChildren();
  for (const result of results) {
    const button = node('button', { type: 'button', text: result.name });
    button.addEventListener('click', () => applyLocation(result, fallback));
    list.append(node('li', {}, button));
  }
  list.hidden = false;
  const status = $('address-status');
  status.textContent = `${fallback ? `입력한 주소 그대로는 없어 '${fallback}'로 찾았습니다. ` : ''}서로 떨어진 후보 ${results.length}곳 중에서 고르세요.`;
  status.hidden = false;
}

// ------------------------------------------------------------ 지도
/** 예측 화면의 작은 지도: 누르면 그 위치가 위도·경도 입력란에 들어간다. */
function drawPickMap() {
  if (!baseMap) return;
  renderKoreaMap($('pick-map'), {
    base: baseMap,
    sites: meta.sites,
    selected: { lat: Number($('lat').value), lon: Number($('lon').value) },
    onPick: (lat, lon) => {
      $('region').value = '';
      $('lat').value = lat;
      $('lon').value = lon;
      showError('forecast-error', '');
      drawPickMap();
    },
    label: '위치를 고르는 대한민국 지도. 회색 점은 학습 자료가 있는 발전소 위치.',
  });
}

/** 모델과 데이터 화면의 지도: 학습에 쓴 위치와 쓰지 않은 위치를 색으로 구분한다. */
function drawAboutMap() {
  if (!baseMap || !$('about-map')) return;
  renderKoreaMap($('about-map'), {
    base: baseMap,
    sites: meta.sites,
    categories: true,
    label: `발전소 위치 ${meta.sites.length}곳을 표시한 대한민국 지도.`,
  });
}

// ------------------------------------------------------------ 내일 예측
async function runForecast() {
  showError('forecast-error', '');
  const lat = readNumber('lat', '위도', LIMITS.lat, '°');
  const lon = readNumber('lon', '경도', LIMITS.lon, '°');
  const capacityKw = readNumber('capacity', '설비용량', LIMITS.capacity, 'kW');
  const ratio = readNumber('ratio', '설비 성능 계수', LIMITS.ratio);
  const dateStr = kstDate(Number($('day').value));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ region: $('region').value, lat, lon, capacityKw, ratio }));
  } catch {
    /* 저장이 막힌 브라우저에서도 예측은 계속한다 */
  }

  const { weather } = await fetchForecast(lat, lon, dateStr);
  const day = await predictDay(predictor, meta, { lat, lon, capacityKw, effKw: capacityKw * ratio }, dateStr, weather);
  lastForecast = { day, lat, lon, capacityKw, dateStr };
  renderForecast();
}

function renderForecast() {
  if (!lastForecast) return;
  const { day, lat, lon, capacityKw, dateStr } = lastForecast;
  const result = $('forecast-result');
  const sun = sunriseSunset(lat, lon, dateStr);
  const peak = day.kwh.indexOf(Math.max(...day.kwh));
  const series = [{ name: '예측 발전량', color: 'var(--series-forecast)', values: day.kwh, area: true }];

  result.replaceChildren(
    node('h2', { text: `${dateLabel(dateStr)} 예상 발전량` }),
    node('p', { class: 'hero' }, formatKwh(day.totalKwh), node('span', { class: 'unit', text: 'kWh' })),
    facts([
      ['가장 많이 나오는 시간', day.totalKwh > 0 ? `${peak}~${peak + 1}시 (${formatKwh(day.kwh[peak])} kWh)` : '없음'],
      ['하루 평균 이용률', `${fmt(1).format((day.totalKwh / (capacityKw * 24)) * 100)}%`],
      ['해 뜨는 시각과 지는 시각', sun ? `${clock(sun.rise)} ~ ${clock(sun.set)}` : '해가 뜨지 않음'],
      ['기상 모델 간 예보 차이', spreadText(spreadOf(day))],
    ]),
  );
  if (day.filled > 0) {
    result.append(node('p', { class: 'note', text: `일부 기상 모델의 예보값 ${day.filled}칸이 비어 있어 나머지 모델의 평균으로 채웠습니다.` }));
  }

  const { block, draw } = chartBlock('시간대별 예상 발전량', series, {
    cloud: day.cloud,
    sun,
    label: `${dateLabel(dateStr)} 시간대별 예상 발전량. 합계 ${formatKwh(day.totalKwh)} kWh.`,
  });
  result.append(block);
  result.append(
    tableView(
      ['시간대', '예측 발전량(kWh)', '구름 양(%)', '일사량 예보(W/m²)'],
      day.kwh.map((v, i) => [
        `${i}~${i + 1}시`,
        fmt(1).format(v),
        day.cloud[i] === null ? '' : fmt(0).format(day.cloud[i]),
        day.ghi[i] === null ? '' : fmt(0).format(day.ghi[i]),
      ]),
      `pv-forecast-${dateStr}.csv`,
    ),
  );
  draw();
}

// ------------------------------------------------------------ 지난 날짜로 확인
async function loadActuals() {
  if (!actuals) {
    const response = await fetch('data/actuals.json');
    if (!response.ok) throw new ForecastError('실제 발전량 자료를 불러오지 못했습니다. 페이지를 새로 고친 뒤 다시 시도하세요.');
    actuals = await response.json();
  }
  return actuals;
}

async function runVerify() {
  showError('verify-error', '');
  const plant = meta.plants.find((p) => p.id === $('plant').value);
  const dateStr = $('verify-date').value;
  const [start, end] = meta.periods.test;
  if (!dateStr || dateStr < start || dateStr > end) {
    $('verify-date').focus();
    throw new ForecastError(`날짜는 ${start}부터 ${end} 사이에서 고르세요. 이 기간이 모델 학습에 쓰지 않은 시험 구간입니다.`);
  }
  const data = await loadActuals();
  const actual = data[plant.id]?.[dateStr];
  if (!actual) {
    throw new ForecastError('이 날은 발전소가 멈춰 있었거나 자료가 없어 비교에서 뺀 날입니다. 다른 날짜를 고르세요.');
  }
  const { weather } = await fetchPastForecast(plant.lat, plant.lon, dateStr);
  const day = await predictDay(
    predictor,
    meta,
    { lat: plant.lat, lon: plant.lon, capacityKw: plant.capacity_kw, effKw: plant.eff_kw ?? undefined },
    dateStr,
    weather,
  );
  lastVerify = { day, plant, dateStr, actual };
  renderVerify();
}

function renderVerify() {
  if (!lastVerify) return;
  const { day, plant, dateStr, actual } = lastVerify;
  const result = $('verify-result');
  const sun = sunriseSunset(plant.lat, plant.lon, dateStr);
  const hours = day.daylight.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
  const errorRate = (hours.reduce((a, i) => a + Math.abs(day.kwh[i] - actual[i]), 0) / hours.length / plant.capacity_kw) * 100;
  const actualTotal = actual.reduce((a, b) => a + b, 0);
  const ok = errorRate <= meta.target;
  const verdict = node('span', { class: 'status' }, statusIcon(ok), node('span', { text: ok ? `${meta.target}% 이내` : `${meta.target}% 초과` }));
  const series = [
    { name: '예측(전날 예보로 계산)', color: 'var(--series-forecast)', values: day.kwh, area: true },
    { name: '실제 발전량', color: 'var(--series-actual)', values: actual, markers: true },
  ];

  result.replaceChildren(
    node('h2', { text: `${plant.name}, ${dateLabel(dateStr)} 낮 시간 평균 오차율` }),
    node('p', { class: 'hero' }, fmt(1).format(errorRate), node('span', { class: 'unit', text: '% (설비용량 대비)' })),
    facts([
      ['판정', verdict],
      ['예측 합계', `${formatKwh(day.totalKwh)} kWh`],
      ['실제 합계', `${formatKwh(actualTotal)} kWh`],
      ['기상 모델 간 예보 차이', spreadText(spreadOf(day))],
    ]),
  );
  const { block, draw } = chartBlock('시간대별 예측과 실제', series, {
    cloud: day.cloud,
    sun,
    label: `${plant.name} ${dateLabel(dateStr)} 시간대별 예측과 실제 발전량. 낮 시간 평균 오차율 ${fmt(1).format(errorRate)}%.`,
  });
  result.append(block);
  result.append(
    tableView(
      ['시간대', '예측(kWh)', '실제(kWh)', '차이(kWh)', '구름 양(%)'],
      day.kwh.map((v, i) => [
        `${i}~${i + 1}시`,
        fmt(1).format(v),
        fmt(1).format(actual[i]),
        fmt(1).format(v - actual[i]),
        day.cloud[i] === null ? '' : fmt(0).format(day.cloud[i]),
      ]),
      `pv-verify-${plant.id}-${dateStr}.csv`,
    ),
  );
  draw();
}

// ------------------------------------------------------------ 모델과 데이터
function renderAbout() {
  const body = $('about-body');
  const table = node('table');
  table.append(
    node('thead', {}, node('tr', {}, ...['모델', '구분', '오차율 NMAE(%)', 'RMSE(%)', 'R²', '발전소 묶음 오차율(%)'].map((c) => node('th', { scope: 'col', text: c })))),
  );
  const tbody = node('tbody');
  for (const m of meta.metrics) {
    tbody.append(
      node(
        'tr',
        {},
        node('td', { text: m.name + (m.final ? ' (서비스에 사용)' : '') }),
        node('td', { text: m.kind }),
        node('td', { text: fmt(2).format(m.nmae) }),
        node('td', { text: fmt(2).format(m.rmse) }),
        node('td', { text: fmt(3).format(m.r2) }),
        node('td', { text: m.portfolio_nmae === null ? '' : fmt(2).format(m.portfolio_nmae) }),
      ),
    );
  }
  table.append(tbody);
  const [testStart, testEnd] = meta.periods.test;

  body.replaceChildren(
    node('h2', { text: '무엇을 하는 서비스인가' }),
    node('p', {
      text: '태양광 발전사업자와 전력중개사업자는 하루 전에 다음 날 발전량을 예측해 제출합니다. 이 서비스는 발전소 위치의 기상 예보를 읽어, 직접 학습한 모델로 시간대별 발전량을 계산합니다. 외부 AI 서비스를 호출하지 않고, 이 페이지가 내려받은 모델 파일을 브라우저 안에서 실행합니다.',
    }),
    node('h2', { text: '계산 순서' }),
    node(
      'ol',
      {},
      node('li', { text: '발전소 위치의 시간대별 예보(일사량, 구름 양, 기온 등 9개 항목)를 기상 모델 3종에서 받습니다.' }),
      node('li', { text: `태양 고도와 대기권 밖 일사량을 계산해 예보값과 합쳐 특성 ${meta.features.length}개를 만듭니다.` }),
      node('li', { text: '학습한 모델이 유효 용량 대비 출력 비율을 내고, 여기에 설비용량과 성능 계수를 곱해 kWh로 바꿉니다.' }),
    ),
    node('h2', { text: `시험 구간 성능 (${testStart} ~ ${testEnd})` }),
    node('p', {
      text: `발전소·호기 ${meta.data.series}개의 낮 시간 ${fmt(0).format(meta.data.test_rows)}건으로 평가했습니다. 오차율은 예측과 실제의 차이를 설비용량으로 나눈 값의 평균입니다. 목표는 발전소를 한 묶음으로 본 오차율 ${meta.target}% 이하이고, 시험 결과는 ${fmt(2).format(meta.goal.portfolio_nmae_active)}%입니다(이용률 10% 이상 시간대). 개별 발전소 평균은 ${fmt(2).format(meta.goal.plant_nmae)}%입니다.`,
    }),
    node('div', { class: 'table-scroll' }, table),
    node('h2', { text: '발전소 분포' }),
    node('p', {
      text: `발전실적을 쓴 위치는 ${meta.sites.length}곳입니다. 점 위에 마우스를 올리면 그 위치의 설비용량과 시험 오차율이 나옵니다.`,
    }),
    legend([
      { name: `학습에 쓴 위치 ${meta.sites.filter((x) => !x.new_site).length}곳`, color: 'var(--series-forecast)', dot: true },
      { name: `학습에 쓰지 않은 위치 ${meta.sites.filter((x) => x.new_site).length}곳`, color: 'var(--series-actual)', dot: true },
    ]),
    node('div', { id: 'about-map', class: 'about-map' }),
    node('h2', { text: '데이터' }),
    node(
      'ul',
      {},
      node('li', { text: '발전실적: 공공데이터포털에 공개된 한국남부발전, 한국동서발전, 한국수력원자력, 한국지역난방공사의 시간대별 태양광 발전실적(이용허락범위 제한 없음).' }),
      node('li', { text: '날씨: Open-Meteo Previous Runs API의 하루 전 예보 이력(CC BY 4.0). 일본 기상청, 유럽중기예보센터, 독일 기상청 모델.' }),
      node('li', { text: `학습 ${meta.periods.train.join(' ~ ')}, 검증 ${meta.periods.val.join(' ~ ')}, 시험 ${meta.periods.test.join(' ~ ')}.` }),
    ),
    node('h2', { text: '알아 둘 한계' }),
    node(
      'ul',
      {},
      node('li', { text: '패널 기울기와 방향, 그늘, 노후 정도는 입력받지 않습니다. 발전소마다 다른 부분은 설비 성능 계수 하나로만 반영합니다.' }),
      node('li', { text: '학습에는 24시간 전에 발표된 예보를 썼습니다. 실제로 예측하는 시각에 따라 예보가 조금 더 이르거나 늦을 수 있습니다.' }),
      node('li', { text: '출력제어, 고장, 눈 쌓임처럼 날씨 예보에 나타나지 않는 발전량 감소는 예측하지 못합니다.' }),
    ),
  );
}

// ------------------------------------------------------------ 초기화
function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    // 숨겨져 있던 화면은 너비가 0이라 차트를 다시 그려야 한다
    if (tab.id === 'tab-forecast') {
      renderForecast();
      drawPickMap();
    }
    if (tab.id === 'tab-verify') renderVerify();
    if (tab.id === 'tab-about') drawAboutMap();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      select(next);
    });
  });
}

function setupForecastForm() {
  const region = $('region');
  for (const [name] of REGIONS) region.append(node('option', { value: name, text: name }));
  region.append(node('option', { value: '', text: '직접 입력' }));
  const fill = () => {
    const found = REGIONS.find(([name]) => name === region.value);
    if (!found) return;
    $('lat').value = found[1];
    $('lon').value = found[2];
  };
  region.addEventListener('change', () => {
    fill();
    drawPickMap();
  });
  for (const id of ['lat', 'lon']) {
    $(id).addEventListener('input', () => {
      region.value = '';
      drawPickMap();
    });
  }

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    saved = null;
  }
  region.value = saved?.region ?? '서울';
  fill();
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
    $('lat').value = saved.lat;
    $('lon').value = saved.lon;
  }
  $('capacity').value = saved?.capacityKw ?? 100;
  $('ratio').value = saved?.ratio ?? meta.default_ratio.toFixed(2);

  const runSearch = async () => {
    const button = $('address-search');
    button.disabled = true;
    button.textContent = '찾는 중';
    try {
      await searchAddress();
    } catch (error) {
      console.error(error);
      showError('forecast-error', error instanceof ForecastError ? error.message : `주소를 찾지 못했습니다. (${error.message})`);
    } finally {
      button.disabled = false;
      button.textContent = '찾기';
    }
  };
  $('address-search').addEventListener('click', runSearch);
  $('address').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // 엔터가 예측 실행으로 넘어가지 않게 한다
    runSearch();
  });

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return showError('forecast-error', '이 브라우저는 현재 위치를 알려 주지 않습니다. 위도와 경도를 직접 입력하세요.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        region.value = '';
        $('lat').value = pos.coords.latitude.toFixed(4);
        $('lon').value = pos.coords.longitude.toFixed(4);
        showError('forecast-error', '');
        drawPickMap();
      },
      () => showError('forecast-error', '현재 위치를 가져오지 못했습니다. 위치 권한을 허용하거나 위도와 경도를 직접 입력하세요.'),
    );
  });
}

function setupVerifyForm() {
  const select = $('plant');
  for (const [label, isNew] of [['학습에 쓴 발전소', false], ['학습에 쓰지 않은 발전소', true]]) {
    const group = node('optgroup', { label });
    for (const p of meta.plants.filter((x) => x.new_site === isNew)) {
      group.append(node('option', { value: p.id, text: `${p.name} (${fmt(0).format(p.capacity_kw)} kW)` }));
    }
    if (group.children.length) select.append(group);
  }
  const describe = () => {
    const p = meta.plants.find((x) => x.id === select.value);
    $('plant-note').textContent = `${p.area}. 시험 구간 평균 오차율 ${fmt(1).format(p.nmae)}%.`;
  };
  select.addEventListener('change', describe);
  describe();

  const [start, end] = meta.periods.test;
  const date = $('verify-date');
  date.min = start;
  date.max = end;
  date.value = end;
  $('date-range').textContent = `${start} ~ ${end} 사이에서 고를 수 있습니다.`;
  $('random-date').addEventListener('click', async () => {
    try {
      const days = Object.keys((await loadActuals())[select.value] || {});
      if (days.length) date.value = days[Math.floor(Math.random() * days.length)];
    } catch (error) {
      showError('verify-error', error.message);
    }
  });
}

function bindSubmit(formId, buttonId, errorId, resultId, run) {
  $(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $(buttonId);
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '계산하는 중';
    $(resultId).classList.add('loading'); // 이전 결과를 흐리게 둔 채로 기다린다
    try {
      await run();
    } catch (error) {
      console.error(error);
      showError(errorId, error instanceof ForecastError ? error.message : `계산하지 못했습니다. 페이지를 새로 고친 뒤 다시 시도하세요. (${error.message})`);
    } finally {
      button.disabled = false;
      button.textContent = label;
      $(resultId).classList.remove('loading');
    }
  });
}

async function init() {
  setupTabs();
  try {
    const response = await fetch('model/meta.json');
    if (!response.ok) throw new Error(`meta.json ${response.status}`);
    meta = await response.json();
    predictor = await createPredictor(ort, meta, async (file) => {
      const res = await fetch(`model/${file}`);
      if (!res.ok) throw new Error(`${file} ${res.status}`);
      return res.arrayBuffer();
    });
  } catch (error) {
    console.error(error);
    $('forecast-placeholder').textContent = '모델 파일을 불러오지 못했습니다. 페이지를 새로 고쳐 보세요.';
    return;
  }
  try {
    const res = await fetch('data/korea.json');
    baseMap = res.ok ? await res.json() : null;
  } catch {
    baseMap = null; // 지도 바탕을 못 읽어도 나머지 기능은 그대로 쓴다
  }
  setupForecastForm();
  setupVerifyForm();
  renderAbout();
  drawPickMap();
  bindSubmit('forecast-form', 'forecast-submit', 'forecast-error', 'forecast-result', runForecast);
  bindSubmit('verify-form', 'verify-submit', 'verify-error', 'verify-result', runVerify);

  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!$('panel-forecast').hidden) {
        renderForecast();
        drawPickMap();
      }
      if (!$('panel-verify').hidden) renderVerify();
      if (!$('panel-about').hidden) drawAboutMap();
    }, 150);
  });

  // 처음 열었을 때 기본 조건으로 바로 한 번 계산해 보여 준다
  $('forecast-placeholder').textContent = '기본 조건으로 내일 발전량을 계산하는 중입니다.';
  $('forecast-form').requestSubmit();
}

init();
