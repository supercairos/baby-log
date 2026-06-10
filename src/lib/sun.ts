/**
 * Sunrise / sunset for a calendar day at a location, via SunCalc. Pass any instant within the
 * day plus coordinates; get back absolute epoch-ms instants (rendered in local time by the
 * caller). `lng` is east-positive, as the Geolocation API returns. Returns null at the poles
 * when the sun doesn't rise/set that day (SunCalc yields Invalid Dates).
 */
import SunCalc from "suncalc";

export function sunTimes(dayMs: number, lat: number, lng: number): { sunrise: number; sunset: number } | null {
  const { sunrise, sunset } = SunCalc.getTimes(new Date(dayMs), lat, lng);
  const r = sunrise.getTime();
  const s = sunset.getTime();
  return Number.isNaN(r) || Number.isNaN(s) ? null : { sunrise: r, sunset: s };
}
