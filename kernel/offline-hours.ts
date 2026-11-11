// Only the worker's offline notice observes these hours. Calendar exceptions are trusted rules data, not a network lookup.
import { nextRun, parseCron, wallClock } from "./cron.ts";
import type { Rules } from "./rules.ts";

/** The first permitted instant at or after this one; without hours the old always-on behavior remains. */
export function offlineNoticeAt(at: number, rules: Rules): number {
  const hours = rules.workerOffline;
  if (!hours) return at;
  const [hour, minute] = hours.start.split(":").map(Number);
  const opening = parseCron(`${minute} ${hour} * * *`)!;
  for (;;) {
    const clock = wallClock(at, rules.timezone);
    const date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day));
    const day = date.toISOString().slice(0, 10);
    const weekday = date.getUTCDay();
    const working = hours.daysOn?.includes(day) || (weekday >= 1 && weekday <= 5 && !hours.daysOff?.includes(day));
    const time = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    if (working && time >= hours.start && time < hours.end) return at;
    at = nextRun(opening, at, rules.timezone)!;
  }
}

export const isOfflineNotice = (key: string) => /^worker:[a-z][a-z0-9-]*:offline:/.test(key);
