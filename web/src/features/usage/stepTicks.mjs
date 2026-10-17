// Ticks every `step` ms on the local-time grid (so 7d midnights survive a DST change in the window).
// The zone offset is re-read per tick, using the offset at the previous guess near a transition.
export const stepTicks = (min, max, step) => {
  const off0 = new Date(min).getTimezoneOffset() * 60_000;
  const ticks = [];
  for (let k = Math.ceil((min - off0) / step); ; k++) {
    const local = k * step;
    const t = local + new Date(local + off0).getTimezoneOffset() * 60_000;
    if (t > max) break;
    ticks.push(new Date(t));
  }
  return ticks;
};
