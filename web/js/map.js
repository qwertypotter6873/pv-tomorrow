// 대한민국 지도: 시·도 경계 위에 발전소 위치를 점으로 찍는다.
// 바탕 자료는 data/korea.json (Natural Earth, 퍼블릭 도메인)이고 외부 지도 서버를 쓰지 않는다.

const NS = 'http://www.w3.org/2000/svg';
const BOUNDS = { lon0: 124.5, lon1: 131.0, lat0: 33.0, lat1: 38.7 };
const COS = Math.cos((36 * Math.PI) / 180); // 위도 36° 기준으로 가로를 줄여 실제 모양에 가깝게 한다
const fmt0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {{provinces:{name:string, polygons:number[][][]}[]}} opts.base 시·도 경계
 * @param {{area:string, lat:number, lon:number, n:number, capacity_kw:number, new_site:boolean, nmae:number}[]} opts.sites
 * @param {{lat:number, lon:number}|null} [opts.selected] 고른 위치(십자 표시)
 * @param {(lat:number, lon:number)=>void} [opts.onPick] 지도를 눌렀을 때 호출. 없으면 누를 수 없는 지도.
 * @param {boolean} [opts.categories] 학습에 쓴 곳과 쓰지 않은 곳을 색으로 구분할지
 * @param {string} opts.label 접근성용 설명
 */
export function renderKoreaMap(host, { base, sites = [], selected = null, onPick = null, categories = false, label }) {
  const width = Math.max(220, Math.floor(host.clientWidth || 280));
  const scale = width / ((BOUNDS.lon1 - BOUNDS.lon0) * COS);
  const height = Math.round((BOUNDS.lat1 - BOUNDS.lat0) * scale);
  const px = (lon) => (lon - BOUNDS.lon0) * COS * scale;
  const py = (lat) => (BOUNDS.lat1 - lat) * scale;

  host.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'map-wrap';
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': label });
  if (onPick) svg.classList.add('pickable');
  wrap.append(svg);

  for (const province of base.provinces) {
    const d = province.polygons
      .map((ring) => ring.map(([lon, lat], i) => `${i ? 'L' : 'M'}${px(lon).toFixed(1)},${py(lat).toFixed(1)}`).join('') + 'Z')
      .join('');
    svg.append(el('path', { d, class: 'map-land' }));
  }

  const radius = categories ? 4.5 : 3.5;
  for (const site of sites) {
    const color = !categories ? 'var(--ink-3)' : site.new_site ? 'var(--series-actual)' : 'var(--series-forecast)';
    svg.append(el('circle', { cx: px(site.lon).toFixed(1), cy: py(site.lat).toFixed(1), r: radius, fill: color, class: 'map-site' }));
  }

  if (selected && Number.isFinite(selected.lat) && Number.isFinite(selected.lon)) {
    const x = px(selected.lon);
    const y = py(selected.lat);
    if (x >= 0 && x <= width && y >= 0 && y <= height) {
      svg.append(el('circle', { cx: x, cy: y, r: 9, class: 'map-pick-halo' }));
      svg.append(el('circle', { cx: x, cy: y, r: 6.5, class: 'map-pick' }));
      svg.append(el('circle', { cx: x, cy: y, r: 2, class: 'map-pick-dot' }));
    }
  }

  // 가장 가까운 점을 찾아 설명을 띄운다(점을 정확히 겨누지 않아도 됨)
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  wrap.append(tip);
  const ring = el('circle', { r: radius + 3.5, class: 'map-hover', visibility: 'hidden' });
  svg.append(ring);

  function locate(event) {
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    let best = null;
    let bestDist = Infinity;
    for (const site of sites) {
      const dist = Math.hypot(px(site.lon) - x, py(site.lat) - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = site;
      }
    }
    return { x, y, site: bestDist <= 14 ? best : null };
  }

  function hide() {
    tip.hidden = true;
    ring.setAttribute('visibility', 'hidden');
  }

  svg.addEventListener('pointermove', (event) => {
    const { site } = locate(event);
    if (!site) return hide();
    const x = px(site.lon);
    const y = py(site.lat);
    ring.setAttribute('cx', x);
    ring.setAttribute('cy', y);
    ring.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const head = document.createElement('strong');
    head.textContent = site.area;
    const line1 = document.createElement('div');
    line1.textContent = `발전소·호기 ${site.n}개, 설비용량 ${fmt0.format(site.capacity_kw)} kW`;
    const line2 = document.createElement('div');
    line2.textContent = Number.isFinite(site.nmae) ? `시험 오차율 ${fmt1.format(site.nmae)}%` : '';
    const line3 = document.createElement('div');
    line3.className = 'tip-extra';
    line3.textContent = site.new_site ? '학습에 쓰지 않은 위치' : '학습에 쓴 위치';
    tip.append(head, line1, line2, line3);
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(width - tipW, x + 12 + tipW > width ? x - 12 - tipW : x + 12))}px`;
    tip.style.top = `${Math.max(0, y - 12)}px`;
  });
  svg.addEventListener('pointerleave', hide);

  if (onPick) {
    svg.addEventListener('click', (event) => {
      const { x, y, site } = locate(event);
      if (site) return onPick(site.lat, site.lon);
      const lon = x / (COS * scale) + BOUNDS.lon0;
      const lat = BOUNDS.lat1 - y / scale;
      onPick(Number(lat.toFixed(3)), Number(lon.toFixed(3)));
    });
  }

  host.append(wrap);
}
