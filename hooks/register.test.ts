import { test, expect, mock, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  jobPluginCheck,
  launchdNames,
  MANUAL_RUN_TEXT,
  renderPlist,
  SCAN_NO_SESSIONS,
  SCAN_UNREADABLE,
  SETUP_NO_PROFILE,
  SETUP_USAGE,
  SUMMARY_NO_PROFILE,
  type Session,
} from './pipeline'

const DATA = '/data'
const RUNS = `${DATA}/runs`
const SCAN_PATH = `${RUNS}/setup-scan.md`
const OPTIONS = { options: { dataDir: DATA, setupDays: 1 } }
const TOOL = 'mcp__morning-report__morning_setup_scan'
const DAY_MS = 24 * 3600_000

const PROMPTS: Record<string, string> = {
  'summarizer.md': 'SUMMARIZER profile={{PROFILE}}',
  'setup-scan.md': 'SCAN SYSTEM',
  'morning-setup.md': 'SETUP preview={{PREVIEW}} profile={{PROFILE}}',
  'report.md': 'REPORT profile={{PROFILE}}',
  'report-weekly.md': 'WEEKLY',
  'report-day14.md': 'DAY14 answered={{ANSWERED}}',
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const small = (id: string): Session => ({ id, project: '/p', start: 's', end: 'e', typed: 1, active_minutes: 5, text: `small ${id}` })
const big = (id: string): Session => ({ ...small(id), text: `big ${id} ${'x'.repeat(3_000)}` })

const extractOf = (sessions: Session[]) =>
  JSON.stringify({ sessions, active_minutes: 5 * sessions.length, projects: sessions.length ? [{ project: '/p', active_minutes: 5 * sessions.length }] : [] })

type Proc = { exitCode: number; stdout?: string; stderr?: string }
type ModelCall = { model: string; system: string; prompt: string }
type ModelAnswer = { isAnswered: true; text: string } | { isAnswered: false }

const HOME = '/home'
const ENV = { HOME, PATH: '/usr/bin:/bin' }

type World = {
  extract?: string | Proc | Error
  profile?: string | Error
  files?: Record<string, string>
  mtimes?: Record<string, number>
  env?: Record<string, string>
  proc?: (argv: readonly string[]) => Proc | undefined
  model?: (call: ModelCall) => ModelAnswer | Promise<ModelAnswer>
  submit?: (text: string) => Promise<{ drop: string } | { text: string }>
  registerTool?: Error
  home?: Error
}

type ToolSeen = { name: string; description: string; inputSchema: unknown }

type Seen = {
  argv: string[][]
  cwds: (string | undefined)[]
  models: ModelCall[]
  writes: Map<string, string>
  submits: string[]
  toasts: string[]
  status: (string | undefined)[]
  tools: ToolSeen[]
  // The value last written to the remember line the band above the prompt shows; null when it shows nothing.
  remember: unknown
}

function world(on: On, w: World = {}): Seen {
  const seen: Seen = { argv: [], cwds: [], models: [], writes: new Map(), submits: [], toasts: [], status: [], tools: [], remember: null }
  const held = new Map<string, { value: unknown; version: number }>()
  on('state.get', async (_$, e) => ({ value: { value: held.get(`${e.plugin}/${e.key}`)?.value, version: held.get(`${e.plugin}/${e.key}`)?.version ?? 0 } }) as never)
  on('state.set', async (_$, e) => {
    const version = (held.get(`${e.plugin}/${e.key}`)?.version ?? 0) + 1
    held.set(`${e.plugin}/${e.key}`, { value: e.value, version })
    seen.remember = e.value
    return { value: { isSet: true, version } } as never
  })
  const files: Record<string, string> = { ...w.files }
  if (typeof w.profile === 'string') files[`${DATA}/profile.md`] = w.profile
  const homeFails = w.home
  if (homeFails) on('env.get', async () => ({ deny: homeFails.message }) as never)
  else mock.env(on, w.env ?? ENV)
  on('process.run', async (_$, e) => {
    seen.argv.push([...e.argv])
    seen.cwds.push(e.init?.cwd)
    const own = w.proc?.(e.argv)
    const given = w.extract
    if (!own && e.argv[0] === 'python3' && given instanceof Error) return { deny: given.message } as never
    const extract: Proc = typeof given === 'string' || given === undefined || given instanceof Error ? { exitCode: 0, stdout: typeof given === 'string' ? given : extractOf([]) } : given
    const r = own ?? (e.argv[0] === 'python3' ? extract : { exitCode: 0 })
    return { value: { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path in files || (e.path === `${DATA}/profile.md` && w.profile instanceof Error) }))
  on('fs.list', async (_$, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }) as never)
  on('fs.stat', async (_$, e) => ({ value: { kind: 'file', size: 0, mtimeMs: w.mtimes?.[e.path] ?? 0 } }) as never)
  on('fs.read', async (_$, e) => {
    if (e.path === `${DATA}/profile.md` && w.profile instanceof Error) return { deny: w.profile.message }
    const prompt = /\/prompts\/([^/]+)$/.exec(e.path)?.[1]
    if (prompt !== undefined && prompt in PROMPTS) return { value: PROMPTS[prompt]! }
    if (e.path in files) return { value: files[e.path]! }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.write', async (_$, e) => {
    seen.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.complete', async (_$, e) => {
    const call = { model: e.model, system: e.system ?? '', prompt: e.prompt }
    seen.models.push(call)
    const answer = (await w.model?.(call)) ?? { isAnswered: true, text: '# Setup scan\nbody' }
    return {
      value: answer.isAnswered
        ? { isAnswered: true, text: answer.text, usage: USAGE }
        : { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
    } as never
  })
  on('ui.status', async (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    seen.submits.push(e.text)
    return (await (w.submit?.(e.text) ?? Promise.resolve({ text: e.text }))) as never
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', async (_$, e) => {
    if (w.registerTool) return { deny: w.registerTool.message } as never
    seen.tools.push({ name: e.name, description: e.description, inputSchema: e.inputSchema })
    return { value: { tool: `mcp__morning-report__${e.name}` } } as never
  })
  return seen
}

const setup = async ($: Engine, args = '') =>
  (await $.command.run({ command: 'morning-setup', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

const scan = async ($: Engine, input: Record<string, unknown> = { days: 1 }): Promise<unknown> => {
  const r = await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', ...input })
  return r.deny !== undefined ? `deny: ${r.deny}` : r.result
}

const ran = (seen: Seen, program: string) => seen.argv.filter(a => a[0] === program).length

// The days each extract window spans, read off its --since and --until.
const windowDays = (seen: Seen) =>
  seen.argv
    .filter(a => a[0] === 'python3')
    .map(a => (Date.parse(a[a.indexOf('--until') + 1]!) - Date.parse(a[a.indexOf('--since') + 1]!)) / DAY_MS)

const PREVIEW_TWO = '2 sessions over the last 1 day: 2 summary calls on sonnet, then 1 opus call'

test('/morning-setup submits the interview at once with the preview filled, and makes no model call and writes nothing', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a'), big('b')]) })
  expect(await setup($)).toBe(`starting the setup interview; ${PREVIEW_TWO}`)
  await clock.settle()
  expect(seen.submits).toEqual([`SETUP preview=${PREVIEW_TWO} profile=${SETUP_NO_PROFILE}`])
  expect(seen.models).toEqual([])
  expect(seen.writes.size).toBe(0)
  expect(windowDays(seen)).toEqual([1])
})

test('/morning-setup with blank arguments starts the same interview and runs no scan', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a'), big('b')]), profile: 'mine', files: { [SCAN_PATH]: '# Setup scan' } })
  for (const args of ['', '  ']) {
    expect(await setup($, args)).toBe(`starting the setup interview; ${PREVIEW_TWO}`)
  }
  await clock.settle()
  expect(seen.submits).toEqual(Array(2).fill(`SETUP preview=${PREVIEW_TWO} profile=mine`))
  expect(seen.models).toEqual([])
  expect(seen.writes.size).toBe(0)
  expect(windowDays(seen)).toEqual([1, 1])
})

test('/morning-setup over an empty window fills the no-sessions preview and makes no model call', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  expect(await setup($)).toBe('starting the setup interview; (no sessions in the last 1 day)')
  await clock.settle()
  expect(seen.submits).toEqual([`SETUP preview=(no sessions in the last 1 day) profile=${SETUP_NO_PROFILE}`])
  expect(seen.submits[0]!.startsWith(`SETUP preview=${SCAN_NO_SESSIONS}`)).toBe(true)
  expect(seen.models).toEqual([])
})

for (const [why, extract, reason] of [
  ['exits non-zero', { exitCode: 1, stderr: 'boom' }, 'extract failed: boom'],
  ['cannot start', new Error('python3: command not found'), 'morning-report: $.process.run: python3: command not found'],
  ['prints a changed shape', JSON.stringify({ sessions: [], active_minutes: 0, projects: [{ project: '/p' }] }), 'extract output: projects[0].active_minutes is missing or not a number'],
] as const) {
  test(`/morning-setup whose extract ${why} still submits the interview with nothing to read, and names the reason`, OPTIONS, async ($, on) => {
    const clock = mock.clock(on)
    const seen = world(on, { extract, profile: 'mine' })
    expect(await setup($)).toBe(`starting the setup interview; ${SCAN_UNREADABLE}; ${reason}`)
    await clock.settle()
    expect(seen.submits).toEqual([`SETUP preview=${SCAN_UNREADABLE} profile=mine`])
    expect(seen.submits[0]!.startsWith(`SETUP preview=${SCAN_NO_SESSIONS}`)).toBe(true)
    expect(seen.models).toEqual([])
    expect(seen.writes.size).toBe(0)
  })
}

test('a dropped interview prompt shows a toast naming the command', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { submit: async () => ({ drop: 'busy' }) })
  await setup($)
  await clock.settle()
  expect(seen.toasts).toEqual(['morning-report: /morning-setup prompt was dropped: busy'])
})

test('a rejected interview prompt shows a toast naming the command', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { submit: async () => Promise.reject(new Error('no session')) })
  await setup($)
  await clock.settle()
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith('morning-report: /morning-setup prompt failed: ')).toBe(true)
})

test('the scan tool writes the scan, returns its path, and submits nothing', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a')]), profile: 'my profile' })
  expect(await scan($)).toBe(SCAN_PATH)
  await clock.settle()
  expect(seen.models.map(c => c.system)).toEqual([`SUMMARIZER profile=${SUMMARY_NO_PROFILE}`, 'SCAN SYSTEM'])
  expect(seen.writes.get(SCAN_PATH)).toBe('# Setup scan\nbody\n')
  expect(seen.submits).toEqual([])
  expect(seen.status[0]).toBe('morning-report: 1 session over the last 1 day: 1 summary call on sonnet, then 1 opus call')
  expect(seen.status.at(-1)).toBeUndefined()
})

test('the scan tool reads the days it is given, not setupDays, clamped to 1-7', { options: { dataDir: DATA, setupDays: 7 } }, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]) })
  for (const days of [1, 3, 12, 0, 2.5]) expect(await scan($, { days })).toBe(SCAN_PATH)
  expect(windowDays(seen)).toEqual([1, 3, 7, 1, 2])
  expect(seen.models.filter(c => c.model === 'opus').map(c => /\((\d+) days?\)/.exec(c.prompt)?.[1])).toEqual(['1', '3', '7', '1', '2'])
})

test('a scan with a few sessions not summarized says so in its result and in the scan file', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    extract: extractOf([small('a'), small('b'), small('c'), big('d'), big('e')]),
    model: c => (c.prompt.includes('session d') ? { isAnswered: false } : { isAnswered: true, text: c.model === 'opus' ? '# Setup scan\nbody' : 'ok' }),
  })
  const result = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await result).toBe(`${SCAN_PATH} (1 session not summarized)`)
  expect(seen.models.find(c => c.model === 'opus')!.prompt).toContain('- sessions not summarized: 1')
  expect(seen.writes.get(SCAN_PATH)).toContain('1 of 5 sessions could not be summarized, so Streams seen and Habits cover only part of the window')
  expect(seen.submits).toEqual([])
})

test('a scan fails when the failed batch holds most of the sessions, though it is one batch of three', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, {
    extract: extractOf([small('a'), small('b'), small('c'), big('d'), big('e')]),
    model: c => (c.prompt.includes('session a') ? { isAnswered: false } : { isAnswered: true, text: 'ok' }),
  })
  const result = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await result).toBe('setup scan failed: 3 of 5 summaries failed: sonnet call failed: api-error 529 overloaded')
  expect(seen.writes.has(SCAN_PATH)).toBe(false)
  expect(seen.submits).toEqual([])
})

test('the scan tool over an empty window returns the no-sessions text and makes no model call', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  expect(await scan($)).toBe('(no sessions in the last 1 day)')
  await clock.settle()
  expect(seen.models).toEqual([])
  expect(seen.submits).toEqual([])
  expect(seen.writes.has(SCAN_PATH)).toBe(false)
})

for (const [failing, why] of [
  ['mkdir', 'mkdir: /data/runs: File exists'],
  ['test', ''],
] as const) {
  test(`a scan whose runs folder cannot be written (${failing} fails) stops before the extract and any model call`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      extract: extractOf([small('a')]),
      proc: argv => (argv[0] === failing ? { exitCode: 1, stderr: why } : undefined),
    })
    const result = await scan($)
    expect(result).toBe(`setup scan failed: cannot write to ${RUNS}${why ? `: ${why}` : ''}`)
    expect(ran(seen, 'python3')).toBe(0)
    expect(seen.models).toEqual([])
    expect(await scan($)).toBe(result)
  })
}

test('a second scan while one runs is refused, and the next one after it ends runs', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  let calls = 0
  const seen = world(on, {
    extract: extractOf([small('a')]),
    model: async c => {
      if (c.model === 'sonnet' && calls++ === 0) await held
      return { isAnswered: true, text: '# Setup scan\nbody' }
    },
  })
  const first = scan($)
  while (seen.models.length === 0) await clock.settle()
  expect(await scan($, { days: 2 })).toBe('a setup scan is already running')
  release()
  expect(await first).toBe(SCAN_PATH)
  expect(await scan($)).toBe(SCAN_PATH)
  expect(seen.models.filter(c => c.model === 'opus').length).toBe(2)
})

test('a scan that fails clears the running flag, so the next scan runs', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  let fail = true
  world(on, {
    extract: extractOf([small('a')]),
    model: c => (c.model === 'opus' && fail ? { isAnswered: false } : { isAnswered: true, text: '# Setup scan\nbody' }),
  })
  const first = scan($)
  for (let i = 0; i < 20; i++) await clock.settle()
  expect(await first).toBe('setup scan failed: opus call failed: api-error 529 overloaded')
  fail = false
  expect(await scan($)).toBe(SCAN_PATH)
})

test('/morning-setup with an argument other than schedule or remove gets the usage line and starts no extract and no model call', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]) })
  for (const args of ['scan', 'scan 1', 'goals', 'schedule now']) {
    expect(await setup($, args)).toBe(SETUP_USAGE)
  }
  expect(ran(seen, 'python3')).toBe(0)
  expect(seen.models).toEqual([])
})

test('an extract whose shape changed fails the scan, naming the key, before any model call', OPTIONS, async ($, on) => {
  const seen = world(on, {
    extract: JSON.stringify({ sessions: [small('a')], active_minutes: 5, projects: [{ project: '/p', minutes: 5 }] }),
  })
  expect(await scan($)).toBe('setup scan failed: extract output: projects[0].active_minutes is missing or not a number')
  expect(seen.models).toEqual([])
})

test('a setup whose config cannot be read answers with its failure line, from the command and from the tool', OPTIONS, async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on, { extract: extractOf([small('a')]), home: new Error('no env') })
  const command = await setup($)
  expect(command?.startsWith('morning-setup failed: ')).toBe(true)
  expect(command).toContain('no env')
  const tool = await scan($)
  expect(typeof tool === 'string' && tool.startsWith('setup scan failed: ')).toBe(true)
  expect(tool).toContain('no env')
  await clock.settle()
  expect(ran(seen, 'python3')).toBe(0)
  expect(seen.models).toEqual([])
  expect(seen.submits).toEqual([])
})

const START = { cwd: '/', surface: null, isInteractive: true }

test('session.start registers the morning_setup_scan tool with a days input of 1 to 7', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine' })
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.tools.map(t => t.name)).toEqual(['morning_setup_scan'])
  expect(seen.tools[0]!.inputSchema).toEqual({
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 7 } },
    required: ['days'],
    additionalProperties: false,
  })
  expect(seen.tools[0]!.description).toContain('/morning-setup')
  expect(seen.toasts).toEqual([])
})

test('session.start whose tool registration is refused says so and still calls next', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', registerTool: new Error('name taken') })
  let reached = false
  on('session.start', async () => {
    reached = true
    return { cwd: '/' }
  })
  await $.session.start(START)
  expect(reached).toBe(true)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith('morning_setup_scan not registered: ')).toBe(true)
})

test('session.start with an unreadable profile still calls next and says the profile could not be read', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: new Error('EISDIR: illegal operation on a directory') })
  let reached = false
  on('session.start', async () => {
    reached = true
    return { cwd: '/' }
  })
  await $.session.start(START)
  expect(reached).toBe(true)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]!.startsWith(`morning-report: could not read ${DATA}/profile.md: `)).toBe(true)
  expect(seen.toasts[0]).toContain('EISDIR')
})

test('session.start says to run /morning-setup only when there is no profile', OPTIONS, async ($, on) => {
  const seen = world(on)
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.toasts).toEqual(['morning-report: run /morning-setup to start'])
})

test('session.start with a profile shows no setup toast', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine' })
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  expect(seen.toasts).toEqual([])
})

const REMEMBER_LINE = 'One thing to remember all day: ship the parser'
const REPORT = `# Report\n\n## Working on\nx\n\n## Questions\nq?\n\n${REMEMBER_LINE}\n`
const SUMMARY = '## a — did a thing'
// A run of the report model answers REPORT; the summary calls answer SUMMARY.
const reportModel = (report = REPORT) => (call: ModelCall): ModelAnswer => ({ isAnswered: true, text: call.system.startsWith('REPORT') ? report : SUMMARY })
const reportCalls = (seen: Seen) => seen.models.filter(m => m.system.startsWith('REPORT'))

const morningRun = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'morning-run', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''

// A backfill picks its report date and clock, so the weekday does not depend on when the test runs.
const backfill = (date: string, until = `${date}T05:00:00Z`) => `--backfill ${date} --until ${until}`
const MONDAY = '2026-10-12'
const TUESDAY = '2026-10-13'
const TODAY_LOCAL = () => {
  const now = Date.now()
  return new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

const runRecord = (activeMinutes: number, projects?: { project: string; active_minutes: number }[]) =>
  JSON.stringify({ activeMinutes, ...(projects ? { projects } : {}) })

const MORNING_FILES = { [`${DATA}/profile.md`]: 'mine', [RUNS]: '' }

test('/morning-run writes the report, the summaries and the run record with its projects, then state.json', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a'), small('b')]), profile: 'mine', files: { [RUNS]: '' }, model: reportModel() })
  const today = TODAY_LOCAL()
  expect(await morningRun($)).toBe(`wrote ${DATA}/${today}.md`)
  expect([...seen.writes.keys()]).toEqual([`${RUNS}/${today}-summaries.md`, `${RUNS}/${today}-run.json`, `${DATA}/${today}.md`, `${DATA}/state.json`])
  expect(seen.writes.get(`${DATA}/${today}.md`)).toBe(REPORT.trim() + '\n')
  expect(seen.writes.get(`${RUNS}/${today}-summaries.md`)).toBe(`${SUMMARY}\n`)
  const record = JSON.parse(seen.writes.get(`${RUNS}/${today}-run.json`)!)
  expect(record.activeMinutes).toBe(10)
  expect(record.projects).toEqual([{ project: '/p', active_minutes: 10 }])
  expect(record.sessions).toBe(2)
  expect(JSON.parse(seen.writes.get(`${DATA}/state.json`)!).reportDate).toBe(today)
  expect(seen.remember).toBe('ship the parser')
})

test('a report cut off before its remember line fails and writes no report, run record, summaries or state', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]), profile: 'mine', files: { [RUNS]: '' }, model: reportModel('# Report\n\n## Questions\nq?') })
  const text = await morningRun($)
  expect(text).toContain('without its last line')
  expect(seen.writes.size).toBe(0)
})

test('a backfill writes its report, summaries and run record but never state.json', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]), profile: 'mine', files: { [RUNS]: '' }, model: reportModel() })
  expect(await morningRun($, backfill(TUESDAY))).toBe(`backfilled ${DATA}/${TUESDAY}.md`)
  expect([...seen.writes.keys()].sort()).toEqual([`${DATA}/${TUESDAY}.md`, `${RUNS}/${TUESDAY}-run.json`, `${RUNS}/${TUESDAY}-summaries.md`])
})

test('the report system prompt is report.md alone on a Tuesday with few earlier reports', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', files: { [RUNS]: '' }, model: reportModel() })
  await morningRun($, backfill(TUESDAY))
  expect(reportCalls(seen).map(c => c.system)).toEqual(['REPORT profile=mine'])
})

test('the report system prompt adds the weekly part after report.md on a Monday report date', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', files: { [RUNS]: '' }, model: reportModel() })
  await morningRun($, backfill(MONDAY))
  expect(reportCalls(seen).map(c => c.system)).toEqual(['REPORT profile=mine\n\nWEEKLY'])
})

const earlierReports = (n: number, over: Record<number, string> = {}, answered = 0) => {
  const files: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.parse('2026-09-28T00:00:00Z') + i * DAY_MS).toISOString().slice(0, 10)
    files[`${DATA}/${day}.md`] = over[i] ?? '## Questions\nq'
    if (i < answered) files[`${DATA}/${day}-answers.md`] = 'a'
  }
  return files
}

test('the report system prompt adds the day-14 check-in with answered-of-reports filled, once there are 13 reports', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', files: { [RUNS]: '', ...earlierReports(13, {}, 4) }, model: reportModel() })
  await morningRun($, backfill('2026-10-12'))
  expect(reportCalls(seen).map(c => c.system)).toEqual(['REPORT profile=mine\n\nWEEKLY\n\nDAY14 answered=4 of 13'])
})

test('no day-14 part with only 12 earlier reports', OPTIONS, async ($, on) => {
  const twelve = world(on, { profile: 'mine', files: { [RUNS]: '', ...earlierReports(12) }, model: reportModel() })
  await morningRun($, backfill(TUESDAY))
  expect(reportCalls(twelve).map(c => c.system)).toEqual(['REPORT profile=mine'])
})

test('no day-14 part when one of the last 7 reports already holds the check-in', OPTIONS, async ($, on) => {
  const seen = world(on, { profile: 'mine', files: { [RUNS]: '', ...earlierReports(14, { 12: '## Is this working?\nyes' }) }, model: reportModel() })
  await morningRun($, backfill(TUESDAY))
  expect(reportCalls(seen).map(c => c.system)).toEqual(['REPORT profile=mine'])
})

test('the report prompt sums active time this week from earlier run records plus the extract being reported', OPTIONS, async ($, on) => {
  const seen = world(on, {
    extract: extractOf([small('a')]),
    profile: 'mine',
    files: {
      [RUNS]: '',
      [`${RUNS}/2026-10-05-run.json`]: runRecord(1000, [{ project: '/p', active_minutes: 1000 }]),
      [`${RUNS}/2026-10-06-run.json`]: runRecord(60, [{ project: '/p', active_minutes: 30 }, { project: '/q', active_minutes: 30 }]),
      [`${RUNS}/2026-10-07-run.json`]: runRecord(60),
      [`${RUNS}/2026-10-08-run.json`]: 'not json',
      [`${RUNS}/2026-10-12-run.json`]: runRecord(1000),
      [`${RUNS}/2026-10-09-summaries.md`]: 'ignored',
    },
    model: reportModel(),
  })
  await morningRun($, backfill('2026-10-09'))
  // 10-06 (60) + 10-07 (60) + tonight (5); the unreadable 10-08 counts as nothing, and 10-05 and 10-12 are outside the week.
  const prompt = reportCalls(seen)[0]!.prompt
  expect(prompt).toContain('- active time this week, from Monday to the end of this window: 2.1h')
  expect(prompt).toContain('- time by project this week:\n  - /p: 0.6h\n  - /q: 0.5h')
})

test('the report prompt reads the week from the extract alone when there is no runs folder', OPTIONS, async ($, on) => {
  const seen = world(on, { extract: extractOf([small('a')]), profile: 'mine', model: reportModel() })
  await morningRun($, backfill(TUESDAY))
  expect(reportCalls(seen)[0]!.prompt).toContain('- active time this week, from Monday to the end of this window: 0.1h')
})

test('the report prompt strips the Fast track from every earlier report but the latest', OPTIONS, async ($, on) => {
  const fast = (n: string) => `## Questions\nq${n}\n\n## Fast track\nfast${n}\n\n## Last\nz`
  const seen = world(on, { profile: 'mine', files: { [RUNS]: '', [`${DATA}/2026-10-10.md`]: fast('1'), [`${DATA}/2026-10-11.md`]: fast('2') }, model: reportModel() })
  await morningRun($, backfill(MONDAY))
  const prompt = reportCalls(seen)[0]!.prompt
  expect(prompt).not.toContain('fast1')
  expect(prompt).toContain('fast2')
})

const remembered = async ($: Engine, on: On, w: World) => {
  const seen = world(on, { profile: 'mine', ...w })
  on('session.start', async () => ({ cwd: '/' }))
  await $.session.start(START)
  return { seen, line: seen.remember }
}

const STATE = JSON.stringify({ watermark: 'w', prevWatermark: 'p', reportDate: '2026-10-11' })
const HOURS = 3600_000

test('session.start shows the remember line of the report state.json names', OPTIONS, async ($, on) => {
  const { line } = await remembered($, on, {
    files: { [`${DATA}/state.json`]: STATE, [`${DATA}/2026-10-11.md`]: REPORT, [`${DATA}/2026-10-12.md`]: '# a backfill\nOne thing to remember all day: wrong' },
    mtimes: { [`${DATA}/2026-10-11.md`]: Date.now() - 35 * HOURS },
  })
  expect(line).toBe('ship the parser')
})

test('session.start shows no remember line once the named report is older than 36 hours', OPTIONS, async ($, on) => {
  const { line } = await remembered($, on, {
    files: { [`${DATA}/state.json`]: STATE, [`${DATA}/2026-10-11.md`]: REPORT },
    mtimes: { [`${DATA}/2026-10-11.md`]: Date.now() - 37 * HOURS },
  })
  expect(line).toBeNull()
})

for (const [why, files] of [
  ['there is no state.json', { [`${DATA}/2026-10-11.md`]: REPORT }],
  ['state.json names no reportDate', { [`${DATA}/state.json`]: JSON.stringify({ watermark: 'w' }), [`${DATA}/2026-10-11.md`]: REPORT }],
  ['the report state.json names is missing', { [`${DATA}/state.json`]: STATE }],
] as const) {
  test(`session.start shows no remember line when ${why}`, OPTIONS, async ($, on) => {
    const { line } = await remembered($, on, { files, mtimes: { [`${DATA}/2026-10-11.md`]: Date.now() } })
    expect(line).toBeNull()
  })
}

test('session.start shows no remember line from a report that lacks the line, and never reads a remember.txt', OPTIONS, async ($, on) => {
  const { line } = await remembered($, on, {
    files: { [`${DATA}/state.json`]: STATE, [`${DATA}/2026-10-11.md`]: '# Report\nno line', [`${DATA}/remember.txt`]: 'stale' },
    mtimes: { [`${DATA}/2026-10-11.md`]: Date.now() },
  })
  expect(line).toBeNull()
})

const NAMES = launchdNames(HOME, '501')
const MAC: Record<string, Proc> = {
  'uname -s': { exitCode: 0, stdout: 'Darwin\n' },
  'which claude': { exitCode: 0, stdout: '/bin/claude\n' },
  'id -u': { exitCode: 0, stdout: '501\n' },
  '/bin/sh -c': { exitCode: 0, stdout: 'enabled\n' },
}
// A Mac whose commands answer as MAC does, except the ones `over` names by their first two words.
const mac = (over: Record<string, Proc> = {}) => (argv: readonly string[]) => {
  const key = argv.slice(0, 2).join(' ')
  return over[key] ?? MAC[key]
}
const launchctlCalls = (seen: Seen) => seen.argv.filter(a => a[0] === 'launchctl').map(a => a.slice(1))

test('schedule on a system that is not macOS prints the manual line and runs nothing else', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'uname -s': { exitCode: 0, stdout: 'Linux\n' } }) })
  expect(await setup($, 'schedule')).toBe(MANUAL_RUN_TEXT)
  expect(seen.argv).toEqual([['uname', '-s']])
  expect(seen.writes.size).toBe(0)
})

for (const [why, w, text] of [
  ['uname -s fails', { proc: mac({ 'uname -s': { exitCode: 1, stdout: 'Darwin\n' } }) }, 'cannot schedule: `uname -s` failed or printed nothing'],
  ['uname -s prints nothing', { proc: mac({ 'uname -s': { exitCode: 0, stdout: '\n' } }) }, 'cannot schedule: `uname -s` failed or printed nothing'],
  ['which claude fails', { proc: mac({ 'which claude': { exitCode: 1 } }) }, 'cannot schedule: no claude on PATH (which claude found nothing)'],
  ['which claude prints nothing', { proc: mac({ 'which claude': { exitCode: 0, stdout: ' \n' } }) }, 'cannot schedule: no claude on PATH (which claude found nothing)'],
  ['id -u fails', { proc: mac({ 'id -u': { exitCode: 1, stdout: '501\n' } }) }, 'cannot schedule: `id -u` failed or printed nothing'],
  ['id -u prints nothing', { proc: mac({ 'id -u': { exitCode: 0, stdout: '' } }) }, 'cannot schedule: `id -u` failed or printed nothing'],
  ['HOME is unset', { proc: mac(), env: { PATH: ENV.PATH } }, 'cannot schedule: HOME is not set'],
  ['HOME is empty', { proc: mac(), env: { ...ENV, HOME: '' } }, 'cannot schedule: HOME is not set'],
  ['PATH is unset', { proc: mac(), env: { HOME } }, 'cannot schedule: PATH is not set'],
] as const) {
  test(`schedule refuses when ${why}, and writes no plist and calls no launchctl`, OPTIONS, async ($, on) => {
    const seen = world(on, w)
    expect(await setup($, 'schedule')).toBe(text)
    expect(seen.writes.size).toBe(0)
    expect(launchctlCalls(seen)).toEqual([])
    expect(ran(seen, 'mkdir')).toBe(0)
  })
}

const JOB_VIEW = (seen: string) =>
  `cannot schedule: the job clears every variable but HOME, PATH and the login ones (launchctl setenv included) and runs from ${HOME}, and there \`claude plugin list --json\` ${seen}. Install and enable the plugin for your user (not one project, not under CLAUDE_CONFIG_DIR), then schedule again`

for (const [why, check, text] of [
  ['the job would see no such plugin', { exitCode: 0, stdout: 'absent\n' }, JOB_VIEW('lists morning-report as absent')],
  ['the job would see the plugin disabled', { exitCode: 0, stdout: 'disabled\n' }, JOB_VIEW('lists morning-report as disabled')],
  ['the job would see the plugin list fail', { exitCode: 1, stdout: '', stderr: ' morning-report: claude plugin list failed (exit 2); the job stays\n' }, JOB_VIEW('failed: morning-report: claude plugin list failed (exit 2); the job stays')],
] as const) {
  test(`schedule refuses when ${why}, and writes no plist and calls no launchctl`, OPTIONS, async ($, on) => {
    const seen = world(on, { proc: mac({ '/bin/sh -c': check }) })
    expect(await setup($, 'schedule')).toBe(text)
    expect(seen.writes.size).toBe(0)
    expect(launchctlCalls(seen)).toEqual([])
    expect(ran(seen, 'mkdir')).toBe(0)
  })
}

test('schedule reports a failed bootstrap with the head of its stderr', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'launchctl bootstrap': { exitCode: 5, stderr: '  Bootstrap failed: 5: Input/output error\n' } }) })
  expect(await setup($, 'schedule')).toBe('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error')
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['bootstrap', NAMES.domain, NAMES.plist]])
})

test('schedule writes the plist, reloads the job, and its text names the hours the plist fires', { options: { ...OPTIONS.options, reportHour: 19 } }, async ($, on) => {
  const seen = world(on, { proc: mac() })
  const text = await setup($, 'schedule')
  const plist = seen.writes.get(NAMES.plist)!
  expect(plist).toBe(renderPlist({ claudePath: '/bin/claude', home: HOME, path: ENV.PATH, uid: '501', hour: 19, pluginName: 'morning-report' }))
  const hours = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map(m => m[1]!.padStart(2, '0'))
  expect(/ at (\d\d):00 and hourly until (\d\d):00 /.exec(text ?? '')?.slice(1)).toEqual([hours[0], hours.at(-1)])
  expect(text).toBe(
    `scheduled: com.morning-report runs claude -p /morning-run at 19:00 and hourly until 23:00 (${NAMES.plist}; log ${NAMES.log}). /morning-setup remove undoes it.`,
  )
  const check = jobPluginCheck({ claudePath: '/bin/claude', home: HOME, path: ENV.PATH, pluginName: 'morning-report' })
  const at = seen.argv.findIndex(a => a[0] === '/bin/sh')
  expect([seen.argv[at], seen.cwds[at]]).toEqual([check.argv, check.cwd])
  expect(at).toBeLessThan(seen.argv.findIndex(a => a[0] === 'mkdir'))
  expect(seen.argv.find(a => a[0] === 'mkdir')).toEqual(['mkdir', '-p', NAMES.logDir])
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['bootstrap', NAMES.domain, NAMES.plist]])
})

const REMOVED = `removed the launchd job com.morning-report, ${NAMES.plist} and ${NAMES.logDir}. Your reports, answers, priorities and profile are still in ${DATA}; delete that folder yourself if you want them gone.`

test('remove with nothing installed says so and runs no process', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac() })
  expect(await setup($, 'remove')).toBe(`nothing installed: no ${NAMES.plist}`)
  expect(seen.argv).toEqual([])
})

test('remove with no HOME refuses and runs no process', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), env: { PATH: ENV.PATH }, files: { [NAMES.plist]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: HOME is not set')
  expect(seen.argv).toEqual([])
})

test('remove deletes a log folder left without a plist once launchctl has no job, and says nothing was installed', OPTIONS, async ($, on) => {
  const seen = world(on, {
    proc: mac({ 'launchctl bootout': { exitCode: 3, stderr: 'Boot-out failed: 3: No such process' }, 'launchctl print': { exitCode: 113 } }),
    files: { [NAMES.logDir]: '' },
  })
  expect(await setup($, 'remove')).toBe(`nothing installed: no ${NAMES.plist}; removed the leftover log folder ${NAMES.logDir}`)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['launchctl', 'print', NAMES.target], ['rm', '-rf', NAMES.logDir]])
})

test('remove unloads a job still loaded after its self-removal deleted the plist, then deletes the log folder', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), files: { [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['rm', '-rf', NAMES.logDir]])
})

for (const printExit of [0, 125]) {
  test(`remove keeps a log folder left without a plist and claims nothing when bootout fails and launchctl print exits ${printExit}`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      proc: mac({ 'launchctl bootout': { exitCode: 5, stderr: 'Boot-out failed: 5: Input/output error' }, 'launchctl print': { exitCode: printExit } }),
      files: { [NAMES.logDir]: '' },
    })
    expect(await setup($, 'remove')).toBe('launchctl bootout failed: Boot-out failed: 5: Input/output error; nothing removed')
    expect(ran(seen, 'rm')).toBe(0)
  })
}

test('remove with a log folder left and id -u failing refuses and deletes nothing', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'id -u': { exitCode: 1 } }), files: { [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: `id -u` failed or printed nothing')
  expect(launchctlCalls(seen)).toEqual([])
  expect(ran(seen, 'rm')).toBe(0)
})

test('remove refuses when id -u fails, and calls no launchctl and deletes nothing', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac({ 'id -u': { exitCode: 1 } }), files: { [NAMES.plist]: '' } })
  expect(await setup($, 'remove')).toBe('cannot remove: `id -u` failed or printed nothing')
  expect(launchctlCalls(seen)).toEqual([])
  expect(ran(seen, 'rm')).toBe(0)
})

test('remove unloads the job before it deletes the plist and the log folder', OPTIONS, async ($, on) => {
  const seen = world(on, { proc: mac(), files: { [NAMES.plist]: '', [NAMES.logDir]: '' } })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(seen.argv).toEqual([['id', '-u'], ['launchctl', 'bootout', NAMES.target], ['rm', '-f', NAMES.plist], ['rm', '-rf', NAMES.logDir]])
})

test('remove goes on when bootout fails because launchctl has no such job', OPTIONS, async ($, on) => {
  const seen = world(on, {
    proc: mac({ 'launchctl bootout': { exitCode: 3, stderr: 'Boot-out failed: 3: No such process' }, 'launchctl print': { exitCode: 113 } }),
    files: { [NAMES.plist]: '' },
  })
  expect(await setup($, 'remove')).toBe(REMOVED)
  expect(launchctlCalls(seen)).toEqual([['bootout', NAMES.target], ['print', NAMES.target]])
  expect(seen.argv.filter(a => a[0] === 'rm')).toEqual([['rm', '-f', NAMES.plist], ['rm', '-rf', NAMES.logDir]])
})

for (const printExit of [0, 125]) {
  test(`remove keeps the plist and claims nothing when bootout fails and launchctl print exits ${printExit}`, OPTIONS, async ($, on) => {
    const seen = world(on, {
      proc: mac({ 'launchctl bootout': { exitCode: 5, stderr: ' Boot-out failed: 5: Input/output error\n' }, 'launchctl print': { exitCode: printExit } }),
      files: { [NAMES.plist]: '' },
    })
    expect(await setup($, 'remove')).toBe('launchctl bootout failed: Boot-out failed: 5: Input/output error; nothing removed')
    expect(ran(seen, 'rm')).toBe(0)
  })
}
