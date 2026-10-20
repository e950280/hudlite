import { expect, test } from 'claude-code/testing'

import { afterFetch, AUTO_FETCH_MS, EMPTY, failed, heard, isAutoDue, mayFetch, MIN_FETCH_GAP_MS, newest, parseReading, retryAfterMs, STALE_MS, stateOf } from '../hooks/usage-poll'

const NOW = Date.parse('2026-10-19T06:00:00Z')
const BODY = JSON.stringify({
  five_hour: { utilization: 42, resets_at: '2026-10-19T09:00:00+00:00' },
  seven_day: { utilization: 51, resets_at: '2026-10-22T17:00:00+00:00' },
})
const W = (percent: number) => ({ percent, resetsAt: null })

test('a good answer becomes the reading', async () => {
  const r = afterFetch({ ...EMPTY }, 200, BODY, NOW)
  expect(r.fetchedAt).toBe(NOW)
  expect(r.fiveHour).toEqual({ percent: 42, resetsAt: Date.parse('2026-10-19T09:00:00Z') })
  expect(r.sevenDay?.percent).toBe(51)
  expect(r.lastStatus).toBe(200)
  expect(stateOf(r.fetchedAt, r.failedAt, NOW + 60_000)).toBe('ok')
})

test('a press waits for another session holding a fetch, and for the gap since the last attempt', async () => {
  expect(mayFetch({ ...EMPTY, claimBy: 'a', claimUntil: NOW + 8_000 }, 'b', NOW)).toBe(false)
  expect(mayFetch({ ...EMPTY, claimBy: 'a', claimUntil: NOW + 8_000 }, 'b', NOW + 8_000)).toBe(true)
  const r = afterFetch({ ...EMPTY }, 200, BODY, NOW)
  expect(mayFetch(r, 'a', NOW + MIN_FETCH_GAP_MS - 1)).toBe(false)
  expect(mayFetch(r, 'a', NOW + MIN_FETCH_GAP_MS)).toBe(true)
  // A press may go inside a failure's backoff: it is the person's choice.
  const down = afterFetch(r, 429, '', NOW + 20_000)
  expect(down.backoffUntil > NOW + 20_000 + MIN_FETCH_GAP_MS).toBe(true)
  expect(mayFetch(down, 'a', NOW + 20_000 + MIN_FETCH_GAP_MS)).toBe(true)
})

test("a session's own windows go in when newer; the newest of a session's and a fetch's is shown", async () => {
  let r = heard({ ...EMPTY }, W(30), W(50), NOW, 'a')
  expect(newest(r)).toEqual({ fiveHour: W(30), sevenDay: W(50), at: NOW })
  // An older response from another session does not overwrite it.
  expect(heard(r, W(20), W(40), NOW - 1_000, 'b')).toBe(r)
  r = heard(r, W(31), W(50), NOW + 5_000, 'b')
  expect(r.heard?.by).toBe('b')
  // A fetch newer than the last heard wins; a heard newer than the fetch wins back.
  r = afterFetch(r, 200, BODY, NOW + 10_000)
  expect(newest(r)?.fiveHour?.percent).toBe(42)
  r = heard(r, W(43), W(52), NOW + 20_000, 'a')
  expect(newest(r)?.fiveHour?.percent).toBe(43)
  // No windows: nothing to share.
  expect(heard(r, null, null, NOW + 30_000, 'a')).toBe(r)
})

test('a failure keeps the last good reading, marks it failed and backs off, doubling', async () => {
  const good = afterFetch({ ...EMPTY }, 200, BODY, NOW)
  const once = afterFetch(good, 500, 'oops', NOW + 10_000)
  expect(once.fiveHour?.percent).toBe(42)
  expect(stateOf(once.fetchedAt, once.failedAt, NOW + 10_000)).toBe('failed')
  const twice = failed(once, NOW + 40_000)
  expect(twice.backoffUntil).toBe(NOW + 40_000 + 60_000)
  // A newer reading heard from a session is not failed: the failure is older than it.
  const fresh = heard(twice, W(44), W(52), NOW + 50_000, 'a')
  expect(stateOf(newest(fresh)!.at, fresh.failedAt, NOW + 50_000)).toBe('ok')
  const back = afterFetch(twice, 200, BODY, NOW + 100_000)
  expect(stateOf(back.fetchedAt, back.failedAt, NOW + 100_000)).toBe('ok')
  expect(back.backoffMs).toBe(0)
})

test('a 429 backs off longer, and a longer retry-after wins', async () => {
  const r = afterFetch({ ...EMPTY }, 429, '', NOW, retryAfterMs('120', NOW))
  expect(r.backoffUntil).toBe(NOW + 120_000)
  expect(r.lastStatus).toBe(429)
  expect(afterFetch({ ...EMPTY }, 429, '', NOW).backoffUntil).toBe(NOW + 60_000)
  expect(retryAfterMs(undefined, NOW)).toBe(0)
})

test('an answer without windows, or that is not JSON, is a failure', async () => {
  expect(afterFetch({ ...EMPTY }, 200, '{}', NOW).failedAt).toBe(NOW)
  expect(afterFetch({ ...EMPTY }, 200, '<html>', NOW).failedAt).toBe(NOW)
  expect(parseReading('not json').fetchedAt).toBe(null)
})

test('a reading older than STALE_MS is stale, not failed', async () => {
  expect(stateOf(NOW, null, NOW + STALE_MS + 1)).toBe('stale')
  expect(stateOf(NOW, null, NOW + STALE_MS)).toBe('ok')
  expect(stateOf(null, null, NOW)).toBe('stale')
})

test('the automatic fetch waits a whole interval since the last attempt, and any backoff', async () => {
  expect(isAutoDue({ ...EMPTY }, NOW)).toBe(true)
  const r = afterFetch({ ...EMPTY }, 200, BODY, NOW)
  expect(isAutoDue(r, NOW + AUTO_FETCH_MS - 2_000)).toBe(false)
  expect(isAutoDue(r, NOW + AUTO_FETCH_MS)).toBe(true)
  const down = afterFetch(r, 429, '', NOW, 20 * 60_000)
  expect(isAutoDue(down, NOW + AUTO_FETCH_MS)).toBe(false)
  expect(isAutoDue(down, NOW + 20 * 60_000)).toBe(true)
})

