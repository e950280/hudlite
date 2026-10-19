import { expect, test } from 'claude-code/testing'

import { scan, sessionTotals, windowTotals } from '../hooks/ledger'
import { getClaudeConfigDir } from '../hooks/hud/claude-config-dir'
import { setIo } from '../hooks/shims/host'
import { homedir } from '../hooks/shims/os'

// Where the ledger looks, as it works it out.
const PROJECTS = `${getClaudeConfigDir(homedir())}/projects`
const NOW = Date.parse('2026-10-02T06:10:00Z')

const response = (id: string | null, requestId: string | null, at: string, input: number, output: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    ...(requestId ? { requestId } : {}),
    message: { ...(id ? { id } : {}), model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output } },
  })

// The first session, and a second one resumed from it: the resume copies the first's
// response (m1) into its own file before adding one of its own (m2).
const FIRST = `${PROJECTS}/-p/s1.jsonl`
const RESUMED = `${PROJECTS}/-p/s2.jsonl`
// A transcript whose responses carry no identity: each line is its own response.
const ANONYMOUS = `${PROJECTS}/-q/s3.jsonl`
const FILES: Record<string, string> = {
  [FIRST]: [response('m1', 'r1', '2026-10-02T06:00:00Z', 100, 10)].join('\n') + '\n',
  [RESUMED]: [
    response('m1', 'r1', '2026-10-02T06:00:00Z', 100, 10),
    response('m1', 'r1', '2026-10-02T06:00:00Z', 100, 10),
    response('m2', 'r2', '2026-10-02T06:05:00Z', 200, 20),
  ].join('\n') + '\n',
  [ANONYMOUS]: [response(null, null, '2026-10-02T06:01:00Z', 1, 1), response(null, null, '2026-10-02T06:02:00Z', 2, 2)].join('\n') + '\n',
}

function install(): void {
  setIo({
    stat: async () => ({ kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }),
    read: async () => '',
    write: async () => {},
    list: async dir => {
      const seen = new Map<string, 'file' | 'dir'>()
      for (const path of Object.keys(FILES)) {
        if (!path.startsWith(`${dir}/`)) continue
        const rest = path.slice(dir.length + 1)
        seen.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
      }
      return [...seen].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? FILES[`${dir}/${name}`]!.length : 0, mtimeMs: kind === 'file' ? NOW : 0, isLink: false }))
    },
    // The ledger's awk pass: the range's usage lines, then its byte count.
    run: async argv => {
      const text = (FILES[argv[5]!] ?? '').slice(Number(argv[4]) - 1)
      const lines = text.split('\n').filter(Boolean)
      const stdout = lines.join('\n') + `\n@@${text.length} ${lines.at(-1)?.length ?? 0} 0\n`
      return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    },
  })
}

test('a response copied into a resumed session counts once; distinct responses each count', async () => {
  install()
  await scan(NOW, 0)
  const all = windowTotals(NOW - 3600_000)
  // m1 once (100 + 10), m2 (200 + 20), and the two anonymous lines (1 + 1, 2 + 2).
  expect(all.responses).toBe(4)
  expect(all.input).toBe(303)
  expect(all.output).toBe(33)
  // Each session keeps its own history: the resumed one holds m1 and m2.
  expect(sessionTotals(RESUMED)?.responses).toBe(2)
  expect(sessionTotals(RESUMED)?.input).toBe(300)
  expect(sessionTotals(FIRST)?.responses).toBe(1)
  expect(sessionTotals(ANONYMOUS)?.responses).toBe(2)
})
