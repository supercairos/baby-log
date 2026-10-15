/**
 * Synthetic logs for a baby of a given age — the consultant tables plus noise — in the shape
 * `backtest-predict.mts --file` reads. Not a measure of accuracy (the predictor shares the
 * tables), but the one way to exercise the plan at ages this family hasn't reached: a five-nap
 * day at eighteen months, a dropped second nap at thirteen, a crash on a one-nap day.
 *
 *   npx tsx scripts/synth-logs.mts --months 9 [--days 21] [--seed 7] > /tmp/synth-9m.json
 *   TZ=Europe/Paris npx tsx scripts/backtest-predict.mts --file /tmp/synth-9m.json
 */
const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const months = opt("months", 6);
const days = opt("days", 21);
let seed = opt("seed", 7);

const MIN = 60_000;
const HOUR = 60 * MIN;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
/** Roughly normal noise with the given standard deviation. */
const gauss = (sd: number) => (rnd() + rnd() + rnd() - 1.5) * 2 * sd;

/** Naps, first window, later windows, nap length (minutes), bedtime (hour) — by age. */
const PROFILES: [months: number, naps: number, first: number, mid: number, len: number, bed: number][] = [
  [0, 5, 45, 75, 40, 21],
  [3, 4, 80, 100, 45, 20.5],
  [5, 3, 120, 150, 60, 19.5],
  [8, 2, 150, 180, 80, 19.5],
  [12, 2, 180, 210, 75, 19.5],
  [16, 1, 300, 0, 110, 19.75],
];
let profile = PROFILES[0];
for (const p of PROFILES) if (months >= p[0]) profile = p;
const [, naps, first, mid, len, bedHour] = profile;

const today = new Date();
today.setHours(0, 0, 0, 0);
const birth = new Date(today);
birth.setMonth(birth.getMonth() - months);
const iso = (ms: number) => new Date(ms).toISOString();

const sleeps: { start: string; end: string }[] = [];
const feedings: { start: string; end: string }[] = [];
let bed = today.getTime() - (days + 1) * 24 * HOUR + bedHour * HOUR;
for (let d = days; d >= 1; d--) {
  const dayStart = new Date(today);
  dayStart.setDate(dayStart.getDate() - d);
  const wake = dayStart.getTime() + 7 * HOUR + gauss(20) * MIN;
  sleeps.push({ start: iso(bed), end: iso(wake) });
  let t = wake;
  for (let k = 0; k < naps; k++) {
    const s = t + ((k === 0 ? first : mid) + gauss(25)) * MIN;
    const e = s + (len + gauss(20)) * MIN;
    sleeps.push({ start: iso(s), end: iso(e) });
    t = e;
  }
  bed = dayStart.getTime() + bedHour * HOUR + gauss(15) * MIN;
  for (let f = wake + 20 * MIN; f < bed; f += (3 + gauss(0.5)) * HOUR) feedings.push({ start: iso(f), end: iso(f + 15 * MIN) });
}
process.stdout.write(JSON.stringify({ birthDate: birth.toISOString().slice(0, 10), sleeps, feedings }, null, 1));
