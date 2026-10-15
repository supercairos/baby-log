/**
 * Replay the sleep history through the predictor and score it — the only validation there is,
 * since no source publishes accuracy for wake-window or bedtime predictions.
 *
 *   npx tsx scripts/backtest-predict.mts [--from 2026-09-20] [--to 2026-10-14] [--verbose]
 *                                       [--module src/lib/predict_variant.ts] [--file logs.json]
 *                                       [--by-age]
 *
 * Reads BABYBUDDY_BASE_URL / BABYBUDDY_TOKEN from the environment or .env. Every half hour, it
 * asks the predictor what Home would show (and what the day plan's bedtime is) and compares
 * with what was logged next. `--module` points it at an experimental copy of lib/predict, so
 * a change can be scored against the current file. Run it before changing anything there.
 *
 * `--by-age` breaks every score down by the child's age (0–3, 3–6, 6–9, 9–12, 12–18, 18+
 * months) — the model's weak ages show up as rows. `--file` replays another child's logs
 * instead of the instance's — a public dataset, or an
 * export from another app — so the model is tested at ages this family hasn't reached. The
 * JSON shape is `{ "birthDate": "2025-03-01", "sleeps": [{ "start": iso, "end": iso }],
 * "feedings": [{ "start": iso, "end"?: iso }], "changes": [{ "time": iso }] }` (ISO times
 * with offsets; feedings and changes optional). Convert whatever format the source uses
 * into that; run with TZ set to the child's zone, since the model reads local clock times.
 */
import { readFileSync } from "node:fs";
import type { TimelineEntry } from "../src/api/timeline.ts";
import { lastNight } from "../src/lib/night.ts";
import type * as Predict from "../src/lib/predict.ts";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env — fine */
}
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt("file");
const base = process.env.BABYBUDDY_BASE_URL?.replace(/\/$/, "");
const token = process.env.BABYBUDDY_TOKEN;
if (!file && (!base || !token)) throw new Error("needs BABYBUDDY_BASE_URL and BABYBUDDY_TOKEN (env or .env), or --file");
const verbose = args.includes("--verbose");
const byAge = args.includes("--by-age");
const { planDay, predictNext, predictionAlive }: typeof Predict = await import(
  opt("module") ? new URL(`../${opt("module")}`, import.meta.url).href : "../src/lib/predict.ts"
);

const MIN = 60_000;
const HOUR = 60 * MIN;
const api = async (path: string) => {
  const res = await fetch(`${base}/api/${path}`, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as { results: Record<string, unknown>[] };
};
interface Logs {
  birthDate: string;
  sleeps: { start: string; end: string }[];
  feedings?: { start: string; end?: string }[];
  changes?: { time: string }[];
}
const logs: Logs = file
  ? (JSON.parse(readFileSync(file, "utf8")) as Logs)
  : await (async () => {
      const child = (await api("children/")).results[0] as { id: number; birth_date: string };
      const q = `?child=${child.id}&limit=5000`;
      const [sleep, feedings, changes] = await Promise.all([api(`sleep/${q}`), api(`feedings/${q}`), api(`changes/${q}`)]);
      return {
        birthDate: child.birth_date,
        sleeps: sleep.results.map((s) => ({ start: s.start as string, end: s.end as string })),
        feedings: feedings.results.map((f) => ({ start: f.start as string, end: f.end as string })),
        changes: changes.results.map((c) => ({ time: c.time as string })),
      };
    })();
const birthDate = logs.birthDate;
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
let nextId = 1;
const entries: TimelineEntry[] = [
  ...logs.sleeps.map((s) => ({ id: nextId++, activity: "sleep" as const, path: "/api/sleep/" as const, startMs: ms(s.start), endMs: ms(s.end), nap: null, notes: null })),
  ...(logs.feedings ?? []).map((f) => ({ id: nextId++, activity: "feeding" as const, path: "/api/feedings/" as const, startMs: ms(f.start), endMs: f.end ? ms(f.end) : ms(f.start) + 15 * MIN, type: "breast milk" as const, method: "both breasts" as const, amount: null, notes: null })),
  ...(logs.changes ?? []).map((c) => ({ id: nextId++, activity: "diaper" as const, path: "/api/changes/" as const, startMs: ms(c.time), endMs: null, wet: true, solid: false, notes: null })),
].filter((e) => Number.isFinite(e.startMs) && (e.activity !== "sleep" || Number.isFinite(e.endMs)));
const sleeps = entries.filter((e) => e.activity === "sleep" && e.endMs != null).sort((a, b) => a.startMs - b.startMs);
const isNight = (t: number) => {
  const h = new Date(t).getHours();
  return h >= 18 || h < 6;
};
const fmt = (t: number) => new Date(t).toTimeString().slice(0, 5);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

const from = Date.parse(`${opt("from") ?? day(sleeps[0].startMs)}T07:00:00`);
const to = Date.parse(`${opt("to") ?? day(Date.now())}T23:00:00`);

type Score = { err: number[]; inWindow: number; shown: number; total: number };
const score = (): Score => ({ err: [], inWindow: 0, shown: 0, total: 0 });
/** One score per age band (or one for everything), keyed "all" / "0–3" / "3–6" / … */
type Scores = Map<string, Score>;
const AGE_BANDS = [0, 3, 6, 9, 12, 18];
const bandOf = (now: number): string => {
  if (!byAge) return "all";
  const months = (now - Date.parse(birthDate)) / (30.44 * 24 * HOUR);
  const lo = [...AGE_BANDS].reverse().find((b) => months >= b) ?? 0;
  const hi = AGE_BANDS[AGE_BANDS.indexOf(lo) + 1];
  return hi == null ? `${lo}+` : `${lo}–${hi}`;
};
const napRow: Scores = new Map(); // Home's "Sieste" row vs the next logged nap, on days where naps were logged
const bedRow: Scores = new Map(); // Home's "Coucher" row vs the actual bedtime
const bedPlan: Scores = new Map(); // the day plan's bedtime, at any time of day, vs the actual bedtime
const feedDay: Scores = new Map(); // Home's "Repas" row vs the next logged feed, 07:00–22:00
const feedNight: Scores = new Map(); // … and overnight
const add = (scores: Scores, now: number, p: { etaMs: number; lowMs: number; highMs: number } | null | undefined, actual: number | null) => {
  const key = bandOf(now);
  const s = scores.get(key) ?? score();
  scores.set(key, s);
  s.total++;
  if (!p || actual == null) return;
  s.shown++;
  s.err.push(Math.abs(p.etaMs - actual) / MIN);
  if (actual >= p.lowMs && actual <= p.highMs) s.inWindow++;
};

const feeds = entries.filter((e) => e.activity === "feeding").sort((a, b) => a.startMs - b.startMs);
for (let now = from; now < to; now += 30 * MIN) {
  const h = new Date(now).getHours();
  // What the app would hold: the fortnight the predictor reads, plus a margin.
  const past = entries.filter((e) => e.startMs >= now - 20 * 24 * HOUR && e.startMs < now && (e.endMs ?? e.startMs) <= now);
  // Feeding, round the clock (the night stretch is the hardest call), never mid-feed. The
  // sleep in progress is handed over as Home hands over its running timer.
  // Only where feeds were being logged — a feed within the last day and the next within a
  // day — or a family's lapse in logging would score as the model's failure.
  if (!feeds.some((f) => f.startMs <= now && (f.endMs ?? f.startMs) > now)) {
    const nextFeed = feeds.find((f) => f.startMs > now);
    const lastFeed = [...feeds].reverse().find((f) => f.startMs < now);
    if (nextFeed && lastFeed && nextFeed.startMs - now <= 24 * HOUR && now - lastFeed.startMs <= 24 * HOUR) {
      const asleep = sleeps.find((s) => s.startMs <= now && (s.endMs as number) > now);
      const pf = predictNext(past, birthDate, now, asleep?.startMs ?? null).feeding;
      add(h >= 7 && h < 22 ? feedDay : feedNight, now, pf && pf.confidence >= 0.1 && predictionAlive(pf, now) ? pf : null, nextFeed.startMs);
    }
  }
  if (h < 7 || h >= 22) continue;
  if (sleeps.some((s) => s.startMs <= now && (s.endMs as number) > now)) continue; // asleep
  const next = sleeps.find((s) => s.startMs > now);
  if (!next) continue;
  // The actual bedtime: where tonight's chain begins (the app's own notion of the night, so
  // a night logged in seven pieces scores its first piece, not its first long one), or the
  // first long evening sleep when no chain forms.
  const noonAfter = (() => {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    return d.getTime() + (new Date(now).getHours() >= 12 ? 24 * HOUR : 0) + 24 * HOUR;
  })();
  const chain = lastNight(entries, noonAfter);
  const bedtime =
    chain && chain.startMs > now && chain.startMs - now < 16 * HOUR
      ? { startMs: chain.startMs }
      : (sleeps.find((s) => s.startMs > now && isNight(s.startMs) && (s.endMs as number) - s.startMs >= 90 * MIN) ?? null);
  const napsLoggedToday = sleeps.filter((s) => !isNight(s.startMs) && day(s.startMs) === day(now)).length >= 2;

  const p = predictNext(past, birthDate, now).sleep;
  const shown = p && p.confidence >= 0.1 && predictionAlive(p, now) ? p : null;
  if (shown?.kind === "nap" && napsLoggedToday) add(napRow, now, shown, isNight(next.startMs) ? null : next.startMs);
  if (shown?.kind === "bedtime") add(bedRow, now, shown, bedtime?.startMs ?? null);
  const bed = planDay(past, birthDate, now)?.sleeps.find((x) => x.kind === "bedtime");
  if (bedtime && bedtime.startMs - now < 16 * HOUR) add(bedPlan, now, bed ? { etaMs: bed.startMs, lowMs: bed.lowMs, highMs: bed.highMs } : null, bedtime.startMs);
  if (verbose && shown) console.log(`${day(now)} ${fmt(now)}  ${shown.kind} ~${fmt(shown.etaMs)} [${fmt(shown.lowMs)}–${fmt(shown.highMs)}] ${shown.basis} ${shown.confidence}  → next ${fmt(next.startMs)}`);
}

const report = (label: string, scores: Scores) => {
  console.log(label);
  const keys = [...scores.keys()].sort((a, b) => parseInt(a) - parseInt(b));
  for (const key of keys) {
    const s = scores.get(key)!;
    const e = [...s.err].sort((a, b) => a - b);
    const med = e[Math.floor(e.length / 2)];
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
    console.log(`  ${byAge ? `${key.padEnd(5)} mo · ` : ""}shown ${pct(s.shown, s.total)} of ${s.total} moments · median |error| ${med == null ? "–" : `${Math.round(med)} min`} · within ±30 min ${pct(e.filter((x) => x <= 30).length, e.length)} · actual inside window ${pct(s.inWindow, s.shown)}`);
  }
};
console.log(`${day(from)} → ${day(to)}, ${sleeps.length} sleeps`);
report("Home 'nap' row (days with naps logged)", napRow);
report("Home 'bedtime' row", bedRow);
report("Day plan's bedtime, any time of day", bedPlan);
report("Home 'feeding' row, 07–22h", feedDay);
report("Home 'feeding' row, overnight", feedNight);
