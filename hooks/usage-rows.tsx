// hudlite's two rows under claude-hud's: the 5h / 7d / context gauges, each a
// button that opens its detail line, then the prompt cache and the session's cost.
import type { Elements, RenderElement } from 'claude-code'

import type { Expanded, UsageView, WindowView } from '../types'
import { formatTokens } from './hud/utils/format.js'
import { L } from './lite-i18n.js'

type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`
}
const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`)
const pct = (n: number) => `${Math.round(n)}%`
/** Green under 50, yellow under 80, red from there. */
const tone = (n: number | null) => (n === null ? undefined : n >= 80 ? 'red' : n >= 50 ? 'yellow' : 'green')

export function drawUsage(
  ui: Ui,
  view: UsageView,
  open: Expanded,
  toggle: (which: Exclude<Expanded, null>) => void,
  refresh: () => void,
  indent = 0,
): RenderElement {
  const { Box, Text, Button } = ui
  const sep = <Text dimColor> │ </Text>

  // An 8-cell bar in the gauge's tone: filled for the used part, dim for the rest.
  const bar = (n: number | null) => {
    const used = n === null ? 0 : Math.max(0, Math.min(8, Math.round((n / 100) * 8)))
    // An array, not a fragment: a Button holds Text alone.
    return [
      <Text key="bar-used" color={tone(n)}>{'█'.repeat(used)}</Text>,
      <Text key="bar-rest" dimColor>{'░'.repeat(8 - used)} </Text>,
    ]
  }

  const gauge = (key: 'five' | 'seven', icon: string, label: string, w: WindowView | null, when: (ms: number) => string) =>
    w ? (
      <Button key={`hudlite-${key}`} plain onPress={() => toggle(key)}>
        <Text>{icon} {label} </Text>
        {bar(w.percent)}
        <Text color={tone(w.percent)} bold underline={open === key}>{pct(w.percent)}</Text>
        {w.resetsAt !== null ? <Text dimColor> ↻ {when(w.resetsAt)}</Text> : null}
      </Button>
    ) : (
      <Text key={key} dimColor>{icon} {label} —</Text>
    )

  const ctx = view.context
  const row1 = (
    <Box key="u1" flexDirection="row" flexWrap="wrap" paddingLeft={indent}>
      {gauge('five', '⏱', '5h', view.five, hhmm)}
      {sep}
      {gauge('seven', '📅', '7d', view.seven, dayTime)}
      {sep}
      {/* When the 5h / 7d percent was read; a press fetches it now, as /usage does. */}
      <Button key="hudlite-refresh" plain onPress={refresh}>
        <Text
          color={view.reading.state === 'failed' ? 'red' : view.reading.state === 'stale' && view.reading.at !== null ? 'yellow' : undefined}
          dimColor={view.reading.state === 'ok' || (view.reading.state === 'stale' && view.reading.at === null)}
        >
          {view.reading.state === 'failed' ? '⚠ ' : '↺ '}
          {view.reading.at !== null ? L('updated', { t: hhmm(view.reading.at) }) : view.reading.state === 'failed' ? L('updateFailed') : L('noReading')}
        </Text>
      </Button>
      {view.scoped.map(w => (
        <Box key={`scoped-${w.name}`} flexDirection="row">
          {sep}
          <Text>✨ {w.name} </Text>
          <Text color={tone(w.percent)} bold>{pct(w.percent)}</Text>
          {w.resetsAt !== null ? <Text dimColor> ↻ {dayTime(w.resetsAt)}</Text> : null}
        </Box>
      ))}
    </Box>
  )

  const c = view.cache
  const row2 = (
    <Box key="u2" flexDirection="row" flexWrap="wrap" paddingLeft={indent}>
      <Button key="hudlite-ctx" plain onPress={() => toggle('ctx')}>
        <Text>🧠 {L('context')} </Text>
        {bar(ctx.percent)}
        <Text color={tone(ctx.percent)} bold underline={open === 'ctx'}>{ctx.percent === null ? '—' : pct(ctx.percent)}</Text>
      </Button>
      {sep}
      <Button key="hudlite-cache" plain onPress={() => toggle('cache')}>
        <Text>💾 {L('cache')} </Text>
        {c.hitRatio !== null ? (
          <Text bold underline={open === 'cache'}>{L('hit', { p: pct(c.hitRatio * 100) })}</Text>
        ) : (
          <Text dimColor underline={open === 'cache'}>—</Text>
        )}
        {c.expiresAt !== null ? (
          c.expiresAt > view.now ? (
            c.expiresAt - view.now < 120_000 ? (
              <Text color="yellow"> 🟡 {L('validUntil', { t: hhmm(c.expiresAt) })}</Text>
            ) : (
              <Text> 🟢 {L('validUntil', { t: hhmm(c.expiresAt) })}</Text>
            )
          ) : (
            // Expired: the next message writes the whole context to the cache again.
            <Text color="red"> 🔴 {L('expired')}{ctx.tokens ? L('rewrite', { n: formatTokens(ctx.tokens) }) : ''}</Text>
          )
        ) : null}
      </Button>
      {sep}
      <Button key="hudlite-session" plain onPress={() => toggle('session')}>
        <Text>💰 {L('session')} </Text>
        <Text bold underline={open === 'session'}>{view.sessionUsd === null ? '—' : usd(view.sessionUsd)}</Text>
      </Button>
    </Box>
  )

  // One detail line: the label, then its parts in one Text, so the line wraps as text
  // and a wrapped part never starts its row with a separator.
  const line = (label: string, parts: string[], note = '') => (
    <Box key="ud" flexDirection="row" paddingLeft={indent + 2}>
      <Text color="cyan">└ {label} </Text>
      <Text>
        {parts.join(' · ')}
        {note ? L('note', { s: note }) : ''}
      </Text>
    </Box>
  )

  const detail = (() => {
    if (open === 'five' || open === 'seven') {
      const w = open === 'five' ? view.five : view.seven
      if (!w) return null
      const t = w.totals
      const label = open === 'five' ? '5h' : '7d'
      return t
        ? line(label, [pct(w.percent), L('input', { n: formatTokens(t.input) }), L('output', { n: formatTokens(t.output) }), `≈${usd(t.usd)}`], L('estimate'))
        : line(label, [pct(w.percent), L('counting')])
    }
    if (open === 'ctx') {
      const fill = ctx.tokens !== null ? L('note', { s: `${formatTokens(ctx.tokens)}${ctx.size ? ` / ${formatTokens(ctx.size)}` : ''}` }) : ''
      const head = `${ctx.percent === null ? '—' : pct(ctx.percent)}${fill}`
      return line(L('context'), [head])
    }
    if (open === 'session') {
      const s = view.session
      const cost = view.sessionUsd === null ? '—' : usd(view.sessionUsd)
      // Its subagents' responses count too, as the session's cost does.
      return s
        ? line(L('session'), [cost, L('input', { n: formatTokens(s.input) }), L('output', { n: formatTokens(s.output) })], L('subagents'))
        : line(L('session'), [cost, L('counting')])
    }
    if (open === 'cache') {
      if (c.read === null) return line(L('cache'), [L('noResponse')])
      const parts = [L('read', { n: formatTokens(c.read) }), L('write', { n: formatTokens(c.write ?? 0) }), `TTL ${c.ttl}`]
      if (c.expiresAt !== null) parts.push(L('written', { t: hhmm(c.expiresAt - (c.ttl === '1h' ? 3_600_000 : 300_000)) }))
      return line(L('cache'), parts, L('lastResponse'))
    }
    return null
  })()

  return (
    <Box flexDirection="column">
      {row1}
      {open === 'five' || open === 'seven' ? detail : null}
      {row2}
      {open === 'ctx' || open === 'cache' || open === 'session' ? detail : null}
    </Box>
  )
}
