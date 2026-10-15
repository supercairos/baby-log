/**
 * Convert another app's export into the logs file `backtest-predict.mts --file` reads, so the
 * predictor can be scored on other children — public exports on GitHub cover birth to
 * eighteen months, ages this family hasn't reached. Times come out as the export's local clock
 * (no offset): run the backtest with `TZ` set to that family's zone.
 *
 *   npx tsx scripts/logs-from-export.mts --format glow --birth 2018-11-21 \
 *       --sleep glow_sleep.csv [--feed glow_feed_bottle.csv] [--diaper glow_diaper.csv] > logs.json
 *   npx tsx scripts/logs-from-export.mts --format huckleberry --birth 2024-04-19 --events events.csv
 *   npx tsx scripts/logs-from-export.mts --format babyconnect --birth 2019-12-20 --events eva.csv
 *   npx tsx scripts/logs-from-export.mts --format babytracker --birth 2023-09-03 \
 *       --sleep sleep.csv [--feed nursing.csv] [--diaper diaper.csv]
 *
 * Formats: glow (Glow Baby: `Begin time,End time`, `MM/DD/YYYY h:mm:ss AM/PM`), huckleberry
 * (`Type,Start,End,…`, `YYYY-MM-DD HH:MM`), babyconnect (`Date and Time,End Time,Duration,
 * Activity,…`, `M/D/YY h:mm AM/PM`), babytracker (`Baby,Time,Duration (min),…`, `D/M/YY h:mm
 * am/pm`, duration instead of an end).
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const format = opt("format");
const birthDate = opt("birth");
if (!format || !birthDate) throw new Error("--format and --birth are required");

/** Minimal CSV: quoted fields, embedded commas, CRLF. */
function csv(path: string): string[][] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);
/** `MM/DD/YYYY h:mm[:ss] AM/PM` (or D/M with `dayFirst`), `YYYY-MM-DD HH:MM`, `M/D/YY h:mm am`. */
function parseLocal(text: string, dayFirst = false): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(t);
  if (m) return iso(+m[1], +m[2], +m[3], +m[4], +m[5]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(t);
  if (!m) return null;
  const [a, b] = [+m[1], +m[2]];
  const [mo, d] = dayFirst ? [b, a] : [a, b];
  let h = +m[4];
  const ap = m[7]?.toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return iso(fullYear(+m[3]), mo, d, h, +m[5], m[6] ? +m[6] : 0);
}
const addMinutes = (localIso: string, minutes: number) => {
  const d = new Date(localIso);
  d.setMinutes(d.getMinutes() + minutes);
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
};

const sleeps: { start: string; end: string }[] = [];
const feedings: { start: string; end?: string }[] = [];
const changes: { time: string }[] = [];
const header = (rows: string[][], name: string) => rows[0].findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

if (format === "glow") {
  for (const r of csv(opt("sleep")!).slice(1)) {
    const start = parseLocal(r[0]);
    const end = parseLocal(r[1]);
    // Glow's author inserted one-minute dummy rows as day markers.
    if (start && end && Date.parse(end) - Date.parse(start) > 2 * 60_000) sleeps.push({ start, end });
  }
  if (opt("feed")) for (const r of csv(opt("feed")!).slice(1)) {
    const start = parseLocal(r[0]);
    if (start) feedings.push({ start });
  }
  if (opt("diaper")) for (const r of csv(opt("diaper")!).slice(1)) {
    const time = parseLocal(r[0]);
    if (time) changes.push({ time });
  }
} else if (format === "huckleberry") {
  // Columns are positional: feed rows carry extra fields that shift the header's names.
  for (const r of csv(opt("events")!).slice(1)) {
    const type = r[0];
    const start = parseLocal(r[1] ?? "");
    const end = parseLocal(r[2] ?? "");
    if (!start) continue;
    if (type === "Sleep" && end) sleeps.push({ start, end });
    else if (type === "Feed") feedings.push({ start, ...(end ? { end } : {}) });
    else if (type === "Diaper") changes.push({ time: start });
  }
} else if (format === "babyconnect") {
  const rows = csv(opt("events")!);
  const iStart = header(rows, "Date and Time") >= 0 ? header(rows, "Date and Time") : header(rows, "Start Time");
  const iEnd = header(rows, "End Time");
  const iAct = header(rows, "Activity");
  for (const r of rows.slice(1)) {
    const start = parseLocal(r[iStart] ?? "");
    const end = parseLocal(r[iEnd] ?? "");
    const act = (r[iAct] ?? "").trim();
    if (!start) continue;
    if (act === "Sleep" && end && end !== start) sleeps.push({ start, end });
    else if (act === "Bottle" || act === "Nursing" || act === "Solid") feedings.push({ start, ...(end ? { end } : {}) });
    else if (act === "Diaper") changes.push({ time: start });
  }
} else if (format === "babytracker") {
  const sl = csv(opt("sleep")!);
  const iTime = header(sl, "Time");
  const iDur = header(sl, "Duration (min)");
  for (const r of sl.slice(1)) {
    const start = parseLocal(r[iTime] ?? "", true);
    const dur = Number(r[iDur]);
    if (start && dur > 0) sleeps.push({ start, end: addMinutes(start, dur) });
  }
  if (opt("feed")) {
    const fd = csv(opt("feed")!);
    const iT = header(fd, "Time");
    const iTot = header(fd, "Total (min)");
    for (const r of fd.slice(1)) {
      const start = parseLocal(r[iT] ?? "", true);
      const dur = Number(r[iTot] ?? 0);
      if (start) feedings.push({ start, ...(dur > 0 ? { end: addMinutes(start, dur) } : {}) });
    }
  }
  if (opt("diaper")) {
    const dp = csv(opt("diaper")!);
    const iT = header(dp, "Time");
    for (const r of dp.slice(1)) {
      const time = parseLocal(r[iT] ?? "", true);
      if (time) changes.push({ time });
    }
  }
} else throw new Error(`unknown format ${format}`);

const span = sleeps.map((s) => s.start).sort();
process.stderr.write(`${sleeps.length} sleeps (${span[0]?.slice(0, 10)} → ${span[span.length - 1]?.slice(0, 10)}), ${feedings.length} feeds, ${changes.length} changes\n`);
process.stdout.write(JSON.stringify({ birthDate, sleeps, feedings, changes }));
