// The account's usage windows, shared by every session on the machine through
// one file beside claude-hud's own cache, so an idle session shows what the
// busiest one last heard. Two sources write it: each session's own responses
// (every API response carries the windows: free, as fresh as the last request
// anywhere), and a fetch of Claude Code's usage endpoint, as /usage reads it:
// every AUTO_FETCH_MS by whichever session finds it due, and on a press of the
// reading. The newest of them is shown. A failed fetch keeps the last good
// reading and backs off, doubling; a 429 starts longer.
import './shims/globals.js'

import { getHudCacheDir } from './hud/claude-config-dir.js'
import * as os from './shims/os.js'
import * as path from './shims/path.js'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/**
 * The automatic fetch's interval, one per machine however many sessions are open. Measured
 * 2026-10-19/20 on one account: every 10 s drew 429s that kept coming for 13 to 35 minutes;
 * every minute a 429 after 19 runs (24 requests in the 30 minutes before it, 32 in the hour),
 * cleared 2 minutes later; every 5 minutes 39 runs and every 2 minutes 134 runs (4.5 hours),
 * all 200. The limit looks like a count over the last half hour or hour, near 30 an hour, and
 * Claude Code's own reads may count toward it: every 2 minutes is 30 an hour, the most measured.
 */
export const AUTO_FETCH_MS = 2 * 60_000

/** Whether the automatic fetch is due: the last attempt is an interval old and no backoff holds. */
export function isAutoDue(r: UsageReading, now: number, everyMs = AUTO_FETCH_MS): boolean {
  if (now < r.backoffUntil) return false
  return now - Math.max(r.fetchedAt ?? 0, r.failedAt ?? 0) >= everyMs - 1_000
}

/** A reading older than this is drawn as stale. */
export const STALE_MS = 5 * 60_000
/** The least time between two fetches, a press included. */
export const MIN_FETCH_GAP_MS = 10_000
const BACKOFF_MIN_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000

export type PolledWindow = { percent: number; resetsAt: number | null }

/** The shared reading, as the file holds it. */
export type UsageReading = {
  /** When the last good reading was fetched (ms); null before one. */
  fetchedAt: number | null
  fiveHour: PolledWindow | null
  sevenDay: PolledWindow | null
  /** When the last attempt failed, if it failed after the last good reading. */
  failedAt: number | null
  /** No fetch before this (ms): a failure's backoff. */
  backoffUntil: number
  backoffMs: number
  /** A fetch in flight: who took it, and until when it holds. */
  claimBy: string | null
  claimUntil: number
  /** The last attempt's HTTP status (0: no answer) and the `retry-after` it gave (ms), for the debug tool. */
  lastStatus?: number
  lastRetryAfterMs?: number
  /** The newest windows a session's own response carried, when that request started (ms), and whose. */
  heard?: { fiveHour: PolledWindow | null; sevenDay: PolledWindow | null; at: number; by: string } | null
}

export const EMPTY: UsageReading = { fetchedAt: null, fiveHour: null, sevenDay: null, failedAt: null, backoffUntil: 0, backoffMs: 0, claimBy: null, claimUntil: 0 }

export function readingPath(): string {
  return path.join(getHudCacheDir(os.homedir()), 'hudlite-usage.json')
}

export function parseReading(text: string | null): UsageReading {
  if (!text) return { ...EMPTY }
  try {
    return { ...EMPTY, ...(JSON.parse(text) as Partial<UsageReading>) }
  } catch {
    return { ...EMPTY }
  }
}

/**
 * Whether a press may fetch now: nobody else holds a fetch, and the last attempt is at
 * least `MIN_FETCH_GAP_MS` old. A press is the person's choice, so it may go inside a
 * failure's backoff; the backoff still says when the next automatic one would.
 */
export function mayFetch(r: UsageReading, me: string, now: number): boolean {
  if (r.claimBy && r.claimBy !== me && now < r.claimUntil) return false
  const last = Math.max(r.fetchedAt ?? 0, r.failedAt ?? 0)
  return now - last >= MIN_FETCH_GAP_MS
}

/** The reading with a session's own response's windows, when they are newer than the last heard. */
export function heard(r: UsageReading, fiveHour: PolledWindow | null, sevenDay: PolledWindow | null, at: number, by: string): UsageReading {
  if (!fiveHour && !sevenDay) return r
  if (r.heard && r.heard.at >= at) return r
  return { ...r, heard: { fiveHour, sevenDay, at, by } }
}

/** The newest windows the reading holds, a session's or a fetch's, and when they were read. */
export function newest(r: UsageReading): { fiveHour: PolledWindow | null; sevenDay: PolledWindow | null; at: number } | null {
  const fetched = r.fetchedAt !== null ? { fiveHour: r.fiveHour, sevenDay: r.sevenDay, at: r.fetchedAt } : null
  const fromSession = r.heard ? { fiveHour: r.heard.fiveHour, sevenDay: r.heard.sevenDay, at: r.heard.at } : null
  if (!fetched) return fromSession
  if (!fromSession) return fetched
  return fromSession.at > fetched.at ? fromSession : fetched
}

export function claimed(r: UsageReading, me: string, now: number): UsageReading {
  return { ...r, claimBy: me, claimUntil: now + 8_000 }
}

function windowOf(raw: unknown): PolledWindow | null {
  const w = raw as { utilization?: unknown; resets_at?: unknown } | null | undefined
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null
  const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
  return { percent: w.utilization, resetsAt: Number.isNaN(at) ? null : at }
}

/** The reading after a fetch answered `status` with `text`. */
export function afterFetch(r0: UsageReading, status: number, text: string, now: number, retryAfterMs = 0): UsageReading {
  const r = { ...r0, lastStatus: status, lastRetryAfterMs: retryAfterMs }
  if (status >= 200 && status < 300) {
    try {
      const body = JSON.parse(text) as { five_hour?: unknown; seven_day?: unknown }
      const fiveHour = windowOf(body.five_hour)
      const sevenDay = windowOf(body.seven_day)
      if (fiveHour || sevenDay) return { ...r, fetchedAt: now, fiveHour, sevenDay, failedAt: null, backoffUntil: 0, backoffMs: 0, claimBy: null, claimUntil: 0 }
    } catch {
      // A body that does not parse is a failure like any other.
    }
  }
  return failed(r, now, status === 429 || status === 403, retryAfterMs)
}

/** The reading after a failed attempt: kept, marked, and backed off (longer on a 429). */
export function failed(r: UsageReading, now: number, isRateLimited = false, retryAfterMs = 0): UsageReading {
  const base = isRateLimited ? BACKOFF_MIN_MS * 2 : BACKOFF_MIN_MS
  const backoffMs = Math.min(BACKOFF_MAX_MS, r.backoffMs > 0 ? r.backoffMs * 2 : base)
  // The server's own `retry-after`, when it gave a longer one, wins.
  const wait = Math.max(backoffMs, Math.min(BACKOFF_MAX_MS, retryAfterMs))
  return { ...r, failedAt: now, backoffMs, backoffUntil: now + wait, claimBy: null, claimUntil: 0 }
}

/** `retry-after` in milliseconds: seconds, or an HTTP date; 0 when absent or unreadable. */
export function retryAfterMs(header: string | undefined, now: number): number {
  if (!header) return 0
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(0, at - now)
}

export type ReadingState = 'ok' | 'stale' | 'failed'

/** How the shown reading stands: fresh, older than `STALE_MS`, or a fetch failed after it was read. */
export function stateOf(at: number | null, failedAt: number | null, now: number): ReadingState {
  if (failedAt !== null && (at === null || failedAt >= at)) return 'failed'
  if (at === null || now - at > STALE_MS) return 'stale'
  return 'ok'
}
