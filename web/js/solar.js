// 태양 위치와 대기권 밖 일사량 계산 (NOAA 간이식).
// 학습 코드 src/solar.py 와 같은 식이다. 한쪽을 바꾸면 다른 쪽도 함께 바꿔야 한다.

const SOLAR_CONSTANT = 1361.0; // W/m2
const RAD = Math.PI / 180;

function dayOfYearUTC(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86400000) + 1;
}

/**
 * @param {number} lat 위도(도)
 * @param {number} lon 경도(도)
 * @param {Date} utc 계산할 시각
 * @returns {{cosZenith:number, azimuth:number, extraGhi:number}}
 */
export function solarGeometry(lat, lon, utc) {
  const doy = dayOfYearUTC(utc);
  const hour = utc.getUTCHours() + utc.getUTCMinutes() / 60;

  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  let trueSolarMin = (hour * 60 + eqtime + 4 * lon) % 1440;
  if (trueSolarMin < 0) trueSolarMin += 1440;
  const hourAngle = (trueSolarMin / 4 - 180) * RAD;
  const latR = lat * RAD;

  let cosZenith = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(hourAngle);
  cosZenith = Math.min(1, Math.max(-1, cosZenith));
  const zenith = Math.acos(cosZenith);

  const sinZenith = Math.max(Math.sin(zenith), 1e-6);
  const cosAz = (Math.sin(decl) - Math.sin(latR) * cosZenith) / (Math.cos(latR) * sinZenith);
  const az = Math.acos(Math.min(1, Math.max(-1, cosAz))) / RAD;
  const azimuth = hourAngle > 0 ? 360 - az : az;

  const earthSun = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const extraGhi = SOLAR_CONSTANT * earthSun * Math.max(cosZenith, 0);
  return { cosZenith, azimuth, extraGhi };
}

/** 해가 뜨고 지는 시각(한국 시각, 소수 시간)을 1분 단위로 찾는다. 해가 뜨지 않으면 null. */
export function sunriseSunset(lat, lon, dateStr) {
  const base = Date.parse(`${dateStr}T00:00:00+09:00`);
  let rise = null;
  let set = null;
  let prev = solarGeometry(lat, lon, new Date(base)).cosZenith;
  for (let minute = 1; minute <= 1440; minute++) {
    const cur = solarGeometry(lat, lon, new Date(base + minute * 60000)).cosZenith;
    if (prev <= 0 && cur > 0 && rise === null) rise = minute / 60;
    if (prev > 0 && cur <= 0) set = minute / 60;
    prev = cur;
  }
  return rise === null || set === null ? null : { rise, set };
}
