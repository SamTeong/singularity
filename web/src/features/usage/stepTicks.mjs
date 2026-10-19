// Hourly and shorter ticks use elapsed time; larger ticks use local time so 7d midnights survive DST.
export const stepTicks = (min, max, step) => {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return [];
  if (step <= 3.6e6) {
    const offset = new Date(min).getTimezoneOffset() * 60_000;
    const first = Math.ceil((min - offset) / step) * step + offset;
    const count = Math.floor((max - first) / step) + 1;
    if (!Number.isFinite(count) || count <= 0 || count > 100_000) return [];
    return Array.from({ length: count }, (_, i) => new Date(first + i * step));
  }
  const off0 = new Date(min).getTimezoneOffset() * 60_000;
  const ticks = [];
  const first = Math.ceil((min - off0) / step);
  const last = Math.floor((max - off0) / step) + 2;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 100_000) return [];
  for (let k = first; k <= last; k++) {
    const local = k * step;
    const t = local + new Date(local + off0).getTimezoneOffset() * 60_000;
    if (t >= min && t <= max && (!ticks.length || t > ticks.at(-1).getTime())) ticks.push(new Date(t));
  }
  return ticks;
};

export const firstTickOfEachLocalDate = (ticks) => {
  const seen = new Set();
  return new Set(ticks.filter((tick) => {
    const date = `${tick.getFullYear()}-${tick.getMonth()}-${tick.getDate()}`;
    if (seen.has(date)) return false;
    seen.add(date);
    return true;
  }).map((tick) => tick.getTime()));
};
