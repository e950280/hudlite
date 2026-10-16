// This machine's API usage, read from Claude Code's transcripts
// (`<config>/projects/**/*.jsonl`): every main-thread and subagent response
// with its model and token counts, so a window (5h, 7d) or one session can be
// summed and priced. The rate-limit windows' percentages are the account's;
// these sums cover only what Claude Code on this machine wrote.
//
// Each file is read incrementally from the offset already consumed, through
// awk, which keeps only the lines that carry a usage block: a transcript is
// mostly tool output, and none of that crosses into the module.
import './shims/globals.js'

import { getClaudeConfigDir } from './hud/claude-config-dir.js'
import { getIo } from './shims/host.js'
import * as os from './shims/os.js'
import * as path from './shims/path.js'

export type Rec = {
  t: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export type Totals = {
  /** Every prompt token: uncached input plus cache reads and writes. */
  input: number
  output: number
  cacheRead: number
  usd: number
  responses: number
}

type Feed = { offset: number; size: number; recs: Map<string, Rec> }

const WEEK_MS = 7 * 24 * 3600_000
const feeds = new Map<string, Feed>()
let isScanning = false
let lastScanAt = 0

/** $ per million tokens: input, output, cache read. Cache writes are 1.25× input (5m) or 2× (1h). */
function priceOf(model: string): [number, number, number] {
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return [10, 50, 0.25]
  if (m.includes('opus-5-5')) return [4, 20, 0.2]
  if (m.includes('opus-5') || /opus-4-[5-9]/.test(m)) return [5, 25, 0.5]
  if (m.includes('opus')) return [15, 75, 1.5]
  if (m.includes('sonnet-5')) return [2, 10, 0.2]
  if (m.includes('sonnet')) return [3, 15, 0.3]
  if (m.includes('haiku-5')) return [0.1, 0.5, 0.01]
  if (m.includes('haiku-4')) return [1, 5, 0.1]
  if (m.includes('haiku')) return [0.8, 4, 0.08]
  return [4, 20, 0.2]
}

export function costOf(r: Rec): number {
  const [i, o, cr] = priceOf(r.model)
  return (r.input * i + r.output * o + r.cacheRead * cr + r.cacheWrite5m * i * 1.25 + r.cacheWrite1h * i * 2) / 1e6
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function parse(line: string): [string, Rec] | null {
  let e: {
    type?: string
    timestamp?: string
    requestId?: string
    message?: { id?: string; model?: string; usage?: Record<string, unknown> & { cache_creation?: Record<string, unknown> } }
  }
  try {
    e = JSON.parse(line)
  } catch {
    return null
  }
  const u = e.message?.usage
  const model = e.message?.model
  if (e.type !== 'assistant' || !u || !model || model === '<synthetic>') return null
  const t = Date.parse(e.timestamp ?? '')
  if (Number.isNaN(t)) return null
  const write = num(u.cache_creation_input_tokens)
  const w1h = num(u.cache_creation?.ephemeral_1h_input_tokens)
  const w5m = u.cache_creation ? num(u.cache_creation.ephemeral_5m_input_tokens) : write - w1h
  // One response is written as several entries (one per content block), each with the same usage.
  const key = `${e.message?.id ?? ''}:${e.requestId ?? ''}` || line
  return [key, { t, model, input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite5m: w5m, cacheWrite1h: w1h }]
}

// Prints the usage lines of bytes [off, off+len), then `@@<bytes seen> <last line's bytes> <last matched>`.
const AWK = `{ n += length($0) + 1; last = length($0); m = (index($0, "\\"usage\\"") && index($0, "\\"assistant\\"")); if (m) print } END { printf "@@%d %d %d\\n", n, last, m }`

async function pull(file: string, size: number): Promise<void> {
  const feed = feeds.get(file) ?? { offset: 0, size: 0, recs: new Map<string, Rec>() }
  feeds.set(file, feed)
  if (size < feed.offset) {
    feed.offset = 0
    feed.recs.clear()
  }
  if (size === feed.offset) return
  const len = size - feed.offset
  const out = await getIo().run(
    ['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3" | LC_ALL=C awk "$4"', 'sh', String(feed.offset + 1), file, String(len), AWK],
    { timeoutMs: 120_000 },
  )
  const lines = out.stdout.split('\n').filter(Boolean)
  const tail = lines.pop() ?? ''
  const match = /^@@(\d+) (\d+) (\d+)$/.exec(tail)
  if (!match) return
  const [seen, last, lastMatched] = [Number(match[1]), Number(match[2]), match[3] === '1']
  // The range ended inside a line still being written: leave it for the next pass.
  let consumed = seen
  if (seen > len) {
    consumed = seen - last - 1
    if (lastMatched) lines.pop()
  }
  for (const line of lines) {
    const rec = parse(line)
    if (rec) feed.recs.set(rec[0], rec[1])
  }
  feed.offset += consumed
  feed.size = size
}

async function walk(dir: string, since: number, found: Map<string, number>, depth: number): Promise<void> {
  const entries = await getIo().list(dir).catch(() => [])
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.kind === 'dir' && depth > 0) await walk(p, since, found, depth - 1)
    else if (e.kind === 'file' && e.name.endsWith('.jsonl') && e.mtimeMs >= since) found.set(p, e.size)
  }
}

/** Reads what the transcripts gained since the last scan; at most once per `minMs`. */
export async function scan(now: number, minMs = 30_000): Promise<void> {
  if (isScanning || now - lastScanAt < minMs) return
  isScanning = true
  try {
    const since = now - WEEK_MS
    const found = new Map<string, number>()
    // projects/<project>/<session>.jsonl and projects/<project>/<session>/subagents/*.jsonl
    await walk(path.join(getClaudeConfigDir(os.homedir()), 'projects'), since, found, 3)
    for (const [file, size] of found) await pull(file, size).catch(() => {})
    for (const [file, feed] of feeds) {
      for (const [k, r] of feed.recs) if (r.t < since) feed.recs.delete(k)
      if (!found.has(file) && feed.recs.size === 0) feeds.delete(file)
    }
    lastScanAt = now
  } finally {
    isScanning = false
  }
}

function sum(recs: Iterable<Rec>, from: number): Totals {
  const t: Totals = { input: 0, output: 0, cacheRead: 0, usd: 0, responses: 0 }
  for (const r of recs) {
    if (r.t < from) continue
    t.input += r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h
    t.output += r.output
    t.cacheRead += r.cacheRead
    t.usd += costOf(r)
    t.responses++
  }
  return t
}

function* all(): Generator<Rec> {
  for (const f of feeds.values()) yield* f.recs.values()
}

/** Everything since `from` (ms), across this machine's sessions. */
export function windowTotals(from: number): Totals {
  return sum(all(), from)
}

/** One session: its transcript and its subagents' (`<session>/subagents/*.jsonl`). */
export function sessionTotals(transcript: string | undefined): Totals | null {
  if (!transcript) return null
  const dir = transcript.replace(/\.jsonl$/, '') + '/'
  function* recs(): Generator<Rec> {
    for (const [file, f] of feeds) if (file === transcript || file.startsWith(dir)) yield* f.recs.values()
  }
  return sum(recs(), 0)
}

/** The newest response in the transcript itself (the main thread), or null. */
export function lastResponse(transcript: string | undefined): Rec | null {
  const feed = transcript ? feeds.get(transcript) : undefined
  let last: Rec | null = null
  for (const r of feed?.recs.values() ?? []) if (!last || r.t >= last.t) last = r
  return last
}

export function hasScanned(): boolean {
  return lastScanAt > 0
}
