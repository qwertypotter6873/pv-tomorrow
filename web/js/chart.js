// 하루(24시간) 발전량 차트. 위쪽 띠는 시간대별 구름 양, 아래는 발전량 곡선이다.
// 두 그림이 같은 시간축을 쓰도록 하나의 SVG 안에 그린다.

const NS = 'http://www.w3.org/2000/svg';
const fmt1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
const fmt0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

export function formatKwh(value) {
  return value >= 100 ? fmt0.format(value) : fmt1.format(value);
}

function clockLabel(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 구름 양(0~100%)을 한 색상(파랑)의 밝기 단계로 바꾼다. 단계 값은 CSS 변수 --sky-0..--sky-6. */
function skyColor(cloud) {
  const step = Math.min(6, Math.max(0, Math.round((cloud / 100) * 6)));
  return `var(--sky-${step})`;
}

/**
 * @param {HTMLElement} host 차트를 넣을 요소
 * @param {object} data
 * @param {{name:string, color:string, values:number[], area?:boolean, markers?:boolean}[]} data.series 길이 24
 * @param {(number|null)[]} data.cloud 시간대별 구름 양(%), 밤은 null
 * @param {{rise:number, set:number}|null} data.sun 일출·일몰(소수 시간)
 * @param {string} data.label 접근성용 설명
 */
export function renderDayChart(host, data) {
  const width = Math.max(320, Math.floor(host.clientWidth || 720));
  const compact = width < 520;
  const margin = { top: 46, right: 16, bottom: 46, left: compact ? 40 : 52 };
  const plotH = compact ? 200 : 250;
  const height = margin.top + plotH + margin.bottom;
  const plotW = width - margin.left - margin.right;
  const x = (hour) => margin.left + (hour / 24) * plotW;

  const peak = Math.max(...data.series.flatMap((s) => s.values), 0);
  // 한 계열일 때는 가장 높은 점 위에 값을 적으므로 위쪽에 여유를 둔다
  const ticks = niceTicks(peak * (data.series.length === 1 ? 1.12 : 1.02));
  const yMax = ticks[ticks.length - 1];
  const y = (v) => margin.top + plotH - (v / yMax) * plotH;

  host.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': data.label, tabindex: 0 });
  wrap.append(svg);

  // 밤 시간 바탕(해가 떠 있는 구간 밖)
  if (data.sun) {
    svg.append(el('rect', { x: x(0), y: margin.top, width: x(data.sun.rise) - x(0), height: plotH, class: 'night' }));
    svg.append(el('rect', { x: x(data.sun.set), y: margin.top, width: x(24) - x(data.sun.set), height: plotH, class: 'night' }));
  }

  // 구름 띠: 시간대마다 한 칸, 칸 사이는 바탕색 2px
  const stripY = 18;
  const stripH = 14;
  svg.append(el('text', { x: margin.left, y: 11, class: 'strip-title' }, '구름 양 예보'));
  const scaleX = x(24) - 118;
  svg.append(el('text', { x: scaleX - 6, y: 11, class: 'strip-scale', 'text-anchor': 'end' }, '맑음'));
  for (let k = 0; k <= 6; k++) {
    svg.append(el('rect', { x: scaleX + k * 12, y: 3, width: 10, height: 9, fill: `var(--sky-${k})`, rx: 1 }));
  }
  svg.append(el('text', { x: scaleX + 7 * 12 + 2, y: 11, class: 'strip-scale' }, '흐림'));
  for (let i = 0; i < 24; i++) {
    const cloud = data.cloud[i];
    svg.append(
      el('rect', {
        x: x(i) + 1,
        y: stripY,
        width: Math.max(1, plotW / 24 - 2),
        height: stripH,
        rx: 2,
        fill: cloud === null || cloud === undefined ? 'var(--strip-empty)' : skyColor(cloud),
      }),
    );
  }

  // 눈금선과 축
  for (const t of ticks) {
    svg.append(el('line', { x1: x(0), x2: x(24), y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
    svg.append(el('text', { x: margin.left - 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, formatKwh(t)));
  }
  svg.append(el('text', { x: margin.left - 8, y: margin.top - 10, class: 'tick', 'text-anchor': 'end' }, 'kWh'));
  for (let h = 0; h <= 24; h += compact ? 6 : 3) {
    svg.append(el('line', { x1: x(h), x2: x(h), y1: margin.top + plotH, y2: margin.top + plotH + 4, class: 'axis' }));
    svg.append(el('text', { x: x(h), y: margin.top + plotH + 18, class: 'tick', 'text-anchor': 'middle' }, `${h}시`));
  }
  if (data.sun) {
    for (const [name, at] of [['일출', data.sun.rise], ['일몰', data.sun.set]]) {
      svg.append(el('line', { x1: x(at), x2: x(at), y1: margin.top, y2: margin.top + plotH, class: 'sunline' }));
      svg.append(
        el('text', { x: x(at), y: margin.top + plotH + 36, class: 'sun-label', 'text-anchor': 'middle' }, `${name} ${clockLabel(at)}`),
      );
    }
  }

  // 자료 표시: 값은 각 시간대의 가운데(i+0.5)에 찍는다
  const firstDay = data.series[0].values.findIndex((v, i) => data.cloud[i] !== null && data.cloud[i] !== undefined);
  const lastDay = 23 - [...data.cloud].reverse().findIndex((c) => c !== null && c !== undefined);
  const from = Math.max(0, (firstDay < 0 ? 0 : firstDay) - 1);
  const to = Math.min(23, (lastDay > 23 ? 23 : lastDay) + 1);
  for (const s of data.series) {
    const pts = [];
    for (let i = from; i <= to; i++) pts.push([x(i + 0.5), y(s.values[i])]);
    const line = pts.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
    if (s.area) {
      const base = y(0);
      svg.append(el('path', { d: `${line}L${pts[pts.length - 1][0].toFixed(1)},${base}L${pts[0][0].toFixed(1)},${base}Z`, fill: s.color, class: 'area' }));
    }
    svg.append(el('path', { d: line, stroke: s.color, class: 'line' }));
    if (s.markers) {
      for (const [px, py] of pts) svg.append(el('circle', { cx: px, cy: py, r: 4, fill: s.color, class: 'marker' }));
    }
  }

  // 한 계열일 때는 가장 높은 시간대 하나에만 값을 적는다
  if (data.series.length === 1 && peak > 0) {
    const values = data.series[0].values;
    const i = values.indexOf(Math.max(...values));
    svg.append(el('circle', { cx: x(i + 0.5), cy: y(values[i]), r: 4, fill: data.series[0].color, class: 'marker' }));
    const anchor = i > 18 ? 'end' : i < 5 ? 'start' : 'middle';
    svg.append(
      el('text', { x: x(i + 0.5), y: y(values[i]) - 10, class: 'direct-label', 'text-anchor': anchor }, `${i}~${i + 1}시 ${formatKwh(values[i])} kWh`),
    );
  }

  // 십자선과 말풍선: 마우스·터치·키보드(좌우 화살표) 모두 같은 내용을 보여 준다
  const cross = el('line', { y1: stripY, y2: margin.top + plotH, class: 'crosshair', visibility: 'hidden' });
  svg.append(cross);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.append(tip);

  let active = -1;
  function show(i) {
    active = i;
    const cx = x(i + 0.5);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = `${i}~${i + 1}시`;
    tip.append(head);
    for (const s of data.series) {
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = s.color;
      const value = document.createElement('strong');
      value.textContent = `${formatKwh(s.values[i])} kWh`;
      const name = document.createElement('span');
      name.textContent = s.name;
      row.append(key, value, name);
      tip.append(row);
    }
    const cloud = data.cloud[i];
    const extra = document.createElement('div');
    extra.className = 'tip-extra';
    extra.textContent = cloud === null || cloud === undefined ? '밤 시간' : `구름 양 ${fmt0.format(cloud)}%`;
    tip.append(extra);
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const left = cx + 12 + tipW > width ? cx - 12 - tipW : cx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${margin.top}px`;
  }
  function hide() {
    active = -1;
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }
  function fromPointer(event) {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const hour = Math.floor(((px - margin.left) / plotW) * 24);
    if (hour < 0 || hour > 23) return hide();
    show(hour);
  }
  svg.addEventListener('pointermove', fromPointer);
  svg.addEventListener('pointerdown', fromPointer);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const start = active < 0 ? 12 : active;
      show(Math.min(23, Math.max(0, start + (event.key === 'ArrowRight' ? 1 : -1))));
    } else if (event.key === 'Escape') {
      hide();
    }
  });

  host.append(wrap);
}
