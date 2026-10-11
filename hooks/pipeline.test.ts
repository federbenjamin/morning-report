import { test, expect } from 'claude-code/testing'
import {
  windowFor,
  activePriorities,
  reportDays,
  batchSessions,
  rememberLine,
  pool,
  localDate,
  parseState,
  windowForRun,
  nextState,
  isPermanent,
  retryDelayS,
  tooManyFailed,
  addUsage,
  type UsageByModel,
  describeFailure,
  sessionBlock,
  type Session,
  launchInstruction,
  parseRunArgs,
  PROFILE_HEADINGS,
  profileHeadingsBlock,
  fillTemplate,
  intOption,
  SETUP_DAYS,
  REPORT_HOUR,
  consentLine,
  summaryOutcome,
  notSummarized,
  type Summary,
  hours,
  scanPrompt,
  scanFileText,
  parseExtracted,
  noSessionsScan,
  SCAN_NO_SESSIONS,
  type Extracted,
  SETUP_ARGUMENT_HINT,
  parseSetupArgs,
  SETUP_USAGE,
  launchdNames,
  renderPlist,
  REPORT_FIRES,
  stderrHead,
  weekdayOf,
  weekRunDays,
  parseRunRecord,
  weekToDate,
  historyBlock,
  reportBlocks,
  IS_THIS_WORKING,
  answeredCount,
  factsBlock,
  reportPrompt,
  type HistoryDay,
} from './pipeline'

const HOUR = 3600_000
const NOW = Date.parse('2026-10-06T12:00:00Z')

const session = (id: string, len: number): Session => ({
  id,
  project: 'p',
  start: 's',
  end: 'e',
  typed: 1,
  active_minutes: 7,
  text: 'x'.repeat(len),
})

test('no watermark looks back 24h', async () => {
  const w = windowFor(undefined, NOW)
  expect(w.since).toBe(new Date(NOW - 24 * HOUR).toISOString())
  expect(w.until).toBe(new Date(NOW).toISOString())
})

test('a recent watermark becomes since', async () => {
  const mark = new Date(NOW - 10 * HOUR).toISOString()
  expect(windowFor(mark, NOW).since).toBe(mark)
})

test('a watermark older than 72h is capped at 72h', async () => {
  const mark = new Date(NOW - 5 * 24 * HOUR).toISOString()
  const w = windowFor(mark, NOW)
  expect(w.since).toBe(new Date(NOW - 72 * HOUR).toISOString())
  expect(w.until).toBe(new Date(NOW).toISOString())
})

test('an unparseable watermark falls back to 24h', async () => {
  expect(windowFor('garbage', NOW).since).toBe(new Date(NOW - 24 * HOUR).toISOString())
})

test('a priority past its until date is dropped, on the date it is kept', async () => {
  const text = 'ship it (until 2026-10-05)\nalways keep this\nlater (until 2026-10-20)'
  expect(activePriorities(text, '2026-10-06')).toBe('always keep this\nlater (until 2026-10-20)')
  expect(activePriorities(text, '2026-10-05')).toBe(text)
})

test('reportDays keeps only dated report files before today, sorted, last 14', async () => {
  expect(
    reportDays(
      ['2026-10-03.md', '2026-10-01.md', '2026-10-01-answers.md', 'priorities.md', '2026-10-06.md', '2026-10-07.md'],
      '2026-10-06',
    ),
  ).toEqual(['2026-10-01', '2026-10-03'])

  const many = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}.md`)
  const days = reportDays(many.reverse(), '2026-10-06')
  expect(days.length).toBe(14)
  expect(days[0]).toBe('2026-09-07')
  expect(days[13]).toBe('2026-09-20')
})

test('big sessions get their own batch and small ones group up to 20000 chars', async () => {
  const big = session('big', 3000)
  const smalls = Array.from({ length: 5 }, (_, i) => session(`s${i}`, 2999))
  const batches = batchSessions([smalls[0]!, big, ...smalls.slice(1)])
  expect(batches.map(b => b.map(s => s.id))).toEqual([['big'], ['s0', 's1', 's2', 's3', 's4']])

  const eight = Array.from({ length: 8 }, (_, i) => session(`t${i}`, 2900))
  // 6 * 2900 = 17400; a 7th would reach 20300 > 20000, so it starts a new batch.
  const grouped = batchSessions(eight)
  expect(grouped.map(b => b.length)).toEqual([6, 2])
})

test('rememberLine extracts plain and bolded lines, undefined when absent', async () => {
  expect(rememberLine('intro\nOne thing to remember all day: call mom\nmore')).toBe('call mom')
  expect(rememberLine('**One thing to remember all day:** call mom')).toBe('call mom')
  expect(rememberLine('nothing here')).toBeUndefined()
})

test('pool preserves order and never exceeds the limit', async () => {
  let running = 0
  let peak = 0
  const items = [1, 2, 3, 4, 5, 6, 7]
  const out = await pool(items, 3, async n => {
    running++
    peak = Math.max(peak, running)
    for (let i = 0; i < 8 - n; i++) await Promise.resolve()
    running--
    return n * 10
  })
  expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
  expect(peak).toBe(3)
})

test('localDate applies the offset across midnight', async () => {
  const ms = Date.parse('2026-10-06T01:00:00Z')
  // getTimezoneOffset convention: UTC-5 is +300 minutes, so 01:00Z is still the 5th.
  expect(localDate(ms, 300)).toBe('2026-10-05')
  expect(localDate(ms, 0)).toBe('2026-10-06')
  // UTC+2 is -120: 23:00Z on the 5th is already the 6th.
  expect(localDate(Date.parse('2026-10-05T23:00:00Z'), -120)).toBe('2026-10-06')
})

test('a rerun on the day a report was written starts at the previous watermark', async () => {
  const prev = new Date(NOW - 20 * HOUR).toISOString()
  const first = new Date(NOW - 2 * HOUR).toISOString()
  const state = { watermark: first, prevWatermark: prev, reportDate: '2026-10-06' }
  expect(windowForRun(state, NOW, '2026-10-06').since).toBe(prev)
  expect(windowForRun(state, NOW, '2026-10-07').since).toBe(first)
  expect(windowForRun({ watermark: first, reportDate: '2026-10-06' }, NOW, '2026-10-06').since).toBe(first)
})

test('a first run with no state, then a same-day rerun, then a next-day run, chain their windows', async () => {
  const t1 = Date.parse('2026-10-06T09:00:00Z')
  const first = windowForRun({}, t1, '2026-10-06')
  expect(first.since).toBe(new Date(t1 - 24 * HOUR).toISOString())
  const s1 = nextState(first.since, first.until, '2026-10-06')
  expect(s1).toEqual({ watermark: first.until, prevWatermark: first.since, reportDate: '2026-10-06' })

  // Same day: the rerun redoes the first run's window, not the span since the first run.
  const t2 = Date.parse('2026-10-06T11:00:00Z')
  const rerun = windowForRun(s1, t2, '2026-10-06')
  expect(rerun.since).toBe(first.since)
  expect(rerun.until).toBe(new Date(t2).toISOString())
  const s2 = nextState(rerun.since, rerun.until, '2026-10-06')
  expect(s2).toEqual({ watermark: rerun.until, prevWatermark: first.since, reportDate: '2026-10-06' })

  // Next day: starts where the previous run ended.
  const t3 = Date.parse('2026-10-07T09:00:00Z')
  const next = windowForRun(s2, t3, '2026-10-07')
  expect(next.since).toBe(rerun.until)
  expect(next.until).toBe(new Date(t3).toISOString())
})

test('parseState reads a good file and flags corrupt ones', async () => {
  expect(parseState('{"watermark":"w","prevWatermark":"p","reportDate":"d"}')).toEqual({
    state: { watermark: 'w', prevWatermark: 'p', reportDate: 'd' },
    corrupt: false,
  })
  expect(parseState('{}').corrupt).toBe(false)
  for (const bad of ['{"watermark":', '', 'null', '[1]', '"x"']) {
    expect(parseState(bad)).toEqual({ state: {}, corrupt: true })
  }
})

test('isPermanent is true for each no-wait-clears error and false for transient ones', async () => {
  for (const error of [
    'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
    'billing_error', 'cloud_credential_error', 'invalid_request', 'model_not_found',
  ]) {
    expect(isPermanent({ reason: 'api-error', error })).toBe(true)
  }
  expect(isPermanent({ reason: 'api-error', status: 429, error: 'rate_limit' })).toBe(false)
  expect(isPermanent({ reason: 'api-error', status: 529, error: 'overloaded' })).toBe(false)
  expect(isPermanent({ reason: 'api-error', status: null, error: 'unknown' })).toBe(false)
  expect(isPermanent({ reason: 'empty-reply' })).toBe(false)
  expect(isPermanent({ reason: 'aborted' })).toBe(false)
})

test('retryDelayS gives a permanent error no retry at any attempt', async () => {
  const f = { reason: 'api-error', status: 401, error: 'authentication_failed' }
  for (const attempt of [0, 1, 2, 3]) expect(retryDelayS(f, attempt)).toBeUndefined()
})

test('retryDelayS retries a 429 with backoff 30, 60, 120, 240 then gives up', async () => {
  const f = { reason: 'api-error', status: 429, error: 'rate_limit' }
  expect([0, 1, 2, 3].map(a => retryDelayS(f, a))).toEqual([30, 60, 120, 240])
  expect(retryDelayS(f, 4)).toBeUndefined()
  expect(retryDelayS(f, 10)).toBeUndefined()
})

test('retryDelayS backs off the same for 5xx, null status and empty replies', async () => {
  for (const f of [
    { reason: 'api-error', status: 529, error: 'overloaded' },
    { reason: 'api-error', status: 500, error: 'server_error' },
    { reason: 'api-error', status: null, error: 'unknown' },
    { reason: 'empty-reply' },
  ]) {
    expect([0, 1, 2, 3, 4].map(a => retryDelayS(f, a))).toEqual([30, 60, 120, 240, undefined])
  }
})

test('retryDelayS retries an aborted call once after 30s', async () => {
  expect(retryDelayS({ reason: 'aborted' }, 0)).toBe(30)
  expect(retryDelayS({ reason: 'aborted' }, 1)).toBeUndefined()
  expect(retryDelayS({ reason: 'aborted' }, 2)).toBeUndefined()
})

test('tooManyFailed is true only when more than half failed', async () => {
  expect(tooManyFailed(0, 0)).toBe(false)
  expect(tooManyFailed(1, 0)).toBe(false)
  expect(tooManyFailed(2, 1)).toBe(false)
  expect(tooManyFailed(3, 1)).toBe(false)
  expect(tooManyFailed(3, 2)).toBe(true)
  expect(tooManyFailed(4, 2)).toBe(false)
  expect(tooManyFailed(4, 3)).toBe(true)
  expect(tooManyFailed(1, 1)).toBe(true)
})

test('addUsage sums per model and counts calls separately for each model', async () => {
  const acc: UsageByModel = {}
  const u = (n: number) => ({
    input_tokens: n, output_tokens: 2 * n, cache_read_input_tokens: 3 * n, cache_creation_input_tokens: 4 * n,
  })
  addUsage(acc, 'sonnet', u(1))
  addUsage(acc, 'opus', u(10))
  addUsage(acc, 'sonnet', u(100))
  expect(acc).toEqual({
    sonnet: { calls: 2, input_tokens: 101, output_tokens: 202, cache_read_input_tokens: 303, cache_creation_input_tokens: 404 },
    opus: { calls: 1, input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  })
})

test('sessionBlock shows the computed active minutes line', async () => {
  const block = sessionBlock({ ...session('abc', 5), active_minutes: 42 })
  expect(block).toContain('your active minutes (computed from your message times): 42')
  expect(block.startsWith('### session abc\n')).toBe(true)
})

test('describeFailure names the model, reason, status and error kind', async () => {
  expect(describeFailure('sonnet', { reason: 'api-error', status: 529, error: 'overloaded' })).toBe(
    'sonnet call failed: api-error 529 overloaded',
  )
  expect(describeFailure('opus', { reason: 'api-error', status: null, error: 'unknown' })).toBe(
    'opus call failed: api-error unknown',
  )
  expect(describeFailure('opus', { reason: 'empty-reply' })).toBe('opus call failed: empty-reply')
})

test('pool stops starting items after the first rejection and rejects', async () => {
  const started: number[] = []
  const run = pool([1, 2, 3, 4, 5, 6], 2, async n => {
    started.push(n)
    for (let i = 0; i < 3; i++) await Promise.resolve()
    if (n === 2) throw new Error('boom')
    return n
  })
  await expect(run).rejects.toThrow('boom')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(started.length).toBeLessThan(6)
  expect(started).not.toContain(6)
})

test('launchInstruction names the command and its slots, or asks for paste-ready prompts', async () => {
  const set = launchInstruction('node d.ts {dir} {name} {prompt}')
  expect(set).toContain('`node d.ts {dir} {name} {prompt}`')
  expect(set).toContain('`{prompt}` is the filled prompt')
  expect(launchInstruction('  ')).toContain('no launch command is set')
})

test('parseRunArgs reads --force and a backfill window of the 24h before --until', async () => {
  expect(parseRunArgs('')).toEqual({ force: false })
  expect(parseRunArgs('--force')).toEqual({ force: true })
  expect(parseRunArgs('--backfill 2026-10-05 --until 2026-10-05T05:21:14.683Z')).toEqual({
    force: false,
    backfill: { date: '2026-10-05', since: '2026-10-04T05:21:14.683Z', until: '2026-10-05T05:21:14.683Z' },
  })
  expect(() => parseRunArgs('--backfill 2026-10-05')).toThrow('--backfill needs --until')
})

test('template filling preserves dollar signs and leaves placeholders without values intact', async () => {
  const template = 'first={{PROFILE}}; again={{PROFILE}}; path={{DATA_DIR}}; call={{call 1}}; unknown={{X}}'
  expect(fillTemplate(template, { PROFILE: '$& is literal', DATA_DIR: '/reports/$HOME' })).toBe(
    'first=$& is literal; again=$& is literal; path=/reports/$HOME; call={{call 1}}; unknown={{X}}',
  )
})

test('invalid number options fall back while finite values floor and stay inside their named bounds', async () => {
  for (const value of [undefined, '3', NaN, Infinity, -Infinity]) expect(intOption(value, SETUP_DAYS)).toBe(7)
  expect(intOption(3.9, SETUP_DAYS)).toBe(3)
  expect(intOption(0, SETUP_DAYS)).toBe(1)
  expect(intOption(-2, SETUP_DAYS)).toBe(1)
  expect(intOption(12, SETUP_DAYS)).toBe(7)
  expect(intOption(-0.1, REPORT_HOUR)).toBe(0)
  expect(intOption(19.9, REPORT_HOUR)).toBe(19)
  expect(intOption(20, REPORT_HOUR)).toBe(19)
})

test('setup consent uses singular only for exactly one day, session, or summary call', async () => {
  expect(consentLine(34, 26, 1, 'sonnet', 'opus')).toBe(
    '34 sessions over the last 1 day: 26 summary calls on sonnet, then 1 opus call',
  )
  expect(consentLine(1, 1, 7, 'sonnet', 'opus')).toBe(
    '1 session over the last 7 days: 1 summary call on sonnet, then 1 opus call',
  )
})

test('profile heading fill stays ordered and carries all five distinct profile prompts', async () => {
  const block = profileHeadingsBlock().split('\n')
  expect(PROFILE_HEADINGS.map(entry => entry.heading)).toEqual([
    'Working on',
    'What the report is for',
    'Counts as progress',
    'Watch for',
    'Track',
  ])
  expect(new Set(PROFILE_HEADINGS.map(entry => entry.heading)).size).toBe(5)
  expect(block).toEqual(PROFILE_HEADINGS.map(entry => `## ${entry.heading} — ${entry.holds}`))
})

test('summaryOutcome counts the sessions in failed batches against all sessions, not batches', async () => {
  const ok = (...ids: string[]): Summary => ({ ids, text: `## ${ids.join(',')}` })
  const bad = (...ids: string[]): Summary => ({ ids, failed: 'rate_limit' })
  expect(() => summaryOutcome([bad('a', 'b', 'c'), ok('d', 'e')])).toThrow('3 of 5 summaries failed: rate_limit')
  expect(() => summaryOutcome([ok('d', 'e'), bad('a', 'b', 'c')])).toThrow('3 of 5 summaries failed: rate_limit')
  expect(summaryOutcome([bad('a'), bad('b'), ok('c', 'd', 'e', 'f', 'g')])).toEqual({
    failed: 2,
    text: ['## a — not summarized (rate_limit)', '## b — not summarized (rate_limit)', '## c,d,e,f,g'],
  })
  expect(summaryOutcome([bad('a', 'b'), ok('c', 'd')]).failed).toBe(2)
  expect(summaryOutcome([])).toEqual({ failed: 0, text: [] })
})

test('notSummarized names the count of sessions, singular for one, and nothing for none', async () => {
  expect(notSummarized(0)).toBe('')
  expect(notSummarized(1)).toBe(' (1 session not summarized)')
  expect(notSummarized(3)).toBe(' (3 sessions not summarized)')
})

test('setup argument parsing starts the interview bare, takes schedule or remove, and refuses the rest', async () => {
  expect(SETUP_ARGUMENT_HINT).toBe('[schedule | remove]')
  expect(SETUP_USAGE).toBe(`usage: /morning-setup ${SETUP_ARGUMENT_HINT}`)
  expect(parseSetupArgs('')).toEqual({ kind: 'interview' })
  expect(parseSetupArgs('   ')).toEqual({ kind: 'interview' })
  expect(parseSetupArgs('schedule')).toEqual({ kind: 'schedule' })
  expect(parseSetupArgs(' remove ')).toEqual({ kind: 'remove' })
  for (const args of ['scan', 'scan 3', 'goals', 'schedule now', 'remove now', 'Schedule', 'run']) {
    expect(parseSetupArgs(args)).toEqual({ kind: 'usage' })
  }
})

test('launchd names use the portable label consistently across the plist, log, domain, and target', async () => {
  expect(launchdNames('/home/x', '501')).toEqual({
    label: 'com.morning-report',
    plist: '/home/x/Library/LaunchAgents/com.morning-report.plist',
    logDir: '/home/x/Library/Logs/com.morning-report',
    log: '/home/x/Library/Logs/com.morning-report/run.log',
    domain: 'gui/501',
    target: 'gui/501/com.morning-report',
  })
})

const PLIST_INPUT = {
  claudePath: '/home/a b/.local/bin/claude',
  home: '/home/a b',
  path: '/home/a b/.local/bin:/usr/bin:/bin',
  uid: '501',
  hour: 5,
  pluginName: 'morning-report',
}
const firedHours = (plist: string) => [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/g)].map(m => Number(m[1]))
const scriptOf = (plist: string) => /<string>([^<]*)<\/string>\n {2}<\/array>/.exec(plist)![1]!

test('rendered plist fires five hours from the report hour, with the names, paths and environment launchd needs', async () => {
  const plist = renderPlist(PLIST_INPUT)
  expect(plist.endsWith('\n')).toBe(true)
  expect(plist.split('<key>Label</key><string>com.morning-report</string>').length).toBe(2)
  expect(firedHours(plist)).toEqual([5, 6, 7, 8, 9])
  expect(plist.split('<key>Minute</key><integer>0</integer>').length).toBe(6)
  expect(plist).toContain(
    '<key>ProgramArguments</key>\n  <array>\n    <string>/bin/sh</string>\n    <string>-c</string>\n' +
      `    <string>exec /usr/bin/env -i \${USER+"USER=$USER"} \${LOGNAME+"LOGNAME=$LOGNAME"} \${SHELL+"SHELL=$SHELL"} \${TMPDIR+"TMPDIR=$TMPDIR"} \${SSH_AUTH_SOCK+"SSH_AUTH_SOCK=$SSH_AUTH_SOCK"} 'HOME=/home/a b' 'PATH=/home/a b/.local/bin:/usr/bin:/bin' /bin/sh -c "$1"</string>\n` +
      '    <string>morning-report</string>\n    <string>list=$(',
  )
  expect(plist).toContain('<key>WorkingDirectory</key><string>/home/a b</string>')
  expect(plist).toContain('<key>PATH</key><string>/home/a b/.local/bin:/usr/bin:/bin</string>')
  expect(plist).toContain('<key>HOME</key><string>/home/a b</string>')
  expect(plist).toContain('<key>StandardOutPath</key><string>/home/a b/Library/Logs/com.morning-report/run.log</string>')
  expect(plist).toContain('<key>StandardErrorPath</key><string>/home/a b/Library/Logs/com.morning-report/run.log</string>')
  expect(firedHours(renderPlist({ ...PLIST_INPUT, hour: 19 }))).toEqual([19, 20, 21, 22, 23])
  const latest = firedHours(renderPlist({ ...PLIST_INPUT, hour: REPORT_HOUR.max }))
  expect(latest.length).toBe(REPORT_FIRES)
  expect(latest.at(-1)).toBe(23)
  expect(renderPlist({ ...PLIST_INPUT, home: '/home/o&brien' })).toContain('<key>HOME</key><string>/home/o&amp;brien</string>')
})

test('rendered plist script runs the report only for an enabled plugin and deletes the plist before bootout only when the list lacks it', async () => {
  const names = launchdNames(PLIST_INPUT.home, PLIST_INPUT.uid)
  const script = scriptOf(renderPlist(PLIST_INPUT))
  expect(script.startsWith(
    `list=$('/home/a b/.local/bin/claude' plugin list --json) || { echo "morning-report: claude plugin list failed (exit $?); the job stays" &gt;&amp;2; exit 1; }; state=$(printf '%s' "$list" | python3 -c 'import json, sys\n`,
  )).toBe(true)
  expect(script.endsWith(
    `print(state)' 'morning-report') || { echo "morning-report: could not read claude plugin list; the job stays" &gt;&amp;2; exit 1; }; ` +
      `if [ "$state" = enabled ]; then exec '/home/a b/.local/bin/claude' -p /morning-run; ` +
      `elif [ "$state" != absent ]; then echo "morning-report: the plugin is $state; nothing run" &gt;&amp;2; ` +
      `else echo 'morning-report: claude plugin list --json does not list morning-report; removing this job: rm -f ${names.plist}, then launchctl bootout ${names.target}' &gt;&amp;2; ` +
      `rm -f '${names.plist}' || exit 1; launchctl bootout '${names.target}'; fi`,
  )).toBe(true)
  expect(script.indexOf(`rm -f '${names.plist}'`)).toBeLessThan(script.indexOf(`launchctl bootout '`))
  expect(script).not.toMatch(/[<>]/)
  expect(script.replaceAll(/&(amp|lt|gt);/g, '')).not.toContain('&')
  const quoted = scriptOf(renderPlist({ ...PLIST_INPUT, claudePath: "/opt/o'k/claude" }))
  expect(quoted).toContain(`list=$('/opt/o'\\''k/claude' plugin list --json)`)
  expect(quoted).toContain(`then exec '/opt/o'\\''k/claude' -p /morning-run;`)
})

test('stderrHead trims the stderr and keeps its first 200 characters', async () => {
  expect(stderrHead('  boom \n')).toBe('boom')
  expect(stderrHead(` ${'x'.repeat(250)}`)).toBe('x'.repeat(200))
  expect(stderrHead('')).toBe('')
})

const extracted = (projects: Extracted['projects']): Extracted => ({
  sessions: [session('a', 10), session('b', 10)],
  active_minutes: 95,
  projects,
})

test('hours formats minutes as tenths of an hour', async () => {
  expect(hours(0)).toBe('0.0h')
  expect(hours(90)).toBe('1.5h')
  expect(hours(95)).toBe('1.6h')
})

test('scanPrompt carries the window, the computed facts per project in the given order, and the summaries', async () => {
  const prompt = scanPrompt({
    since: '2026-10-05T12:00:00.000Z',
    until: '2026-10-06T12:00:00.000Z',
    days: 1,
    extracted: extracted([
      { project: '/work/big', active_minutes: 60 },
      { project: '/work/small', active_minutes: 35 },
    ]),
    failed: 1,
    summaries: ['## a — one', '## b — two'],
  })
  expect(prompt).toBe(
    [
      'Window: 2026-10-05T12:00:00.000Z → 2026-10-06T12:00:00.000Z (1 day).',
      '',
      '# Computed facts (from timestamps; use these, never sum session minutes yourself)',
      '- sessions: 2',
      '- active time across all sessions, overlaps counted once: 1.6h',
      '- time by project, overlaps within a project counted once:',
      '  - /work/big: 1.0h',
      '  - /work/small: 0.6h',
      '- sessions not summarized: 1',
      '',
      '# Session summaries',
      '## a — one',
      '',
      '## b — two',
    ].join('\n'),
  )
})

test('scanFileText says the streams and habits are partial only when some sessions were not summarized', async () => {
  expect(scanFileText('  # Setup scan\nbody\n\n', 0, 34)).toBe('# Setup scan\nbody\n')
  const partial = scanFileText('# Setup scan\nbody', 12, 34)
  expect(partial.startsWith('# Setup scan\nbody\n\n')).toBe(true)
  expect(partial).toContain('12 of 34 sessions could not be summarized')
  expect(partial).toContain('Streams seen and Habits cover only part of the window')
})

test('noSessionsScan starts with the no-sessions marker and names the days', async () => {
  expect(noSessionsScan(1)).toBe('(no sessions in the last 1 day)')
  expect(noSessionsScan(7)).toBe('(no sessions in the last 7 days)')
  expect(noSessionsScan(3).startsWith(SCAN_NO_SESSIONS)).toBe(true)
})

test('parseExtracted returns the extract and names the key a shape change dropped', async () => {
  const good = { sessions: [session('a', 3)], active_minutes: 7, projects: [{ project: 'p', active_minutes: 7 }] }
  expect(parseExtracted(JSON.stringify(good))).toEqual(good)
  expect(parseExtracted(JSON.stringify({ sessions: [], active_minutes: 0, projects: [] }))).toEqual({ sessions: [], active_minutes: 0, projects: [] })
  const without = (o: object, key: string) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)))
  expect(() => parseExtracted(without(good, 'projects'))).toThrow('projects is missing or not an array')
  expect(() => parseExtracted(without(good, 'sessions'))).toThrow('sessions is missing or not an array')
  expect(() => parseExtracted(without(good, 'active_minutes'))).toThrow('active_minutes is missing or not a number')
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: [{ project: 'p', minutes: 7 }] }))).toThrow(
    'projects[0].active_minutes is missing or not a number',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: [{ path: 'p', active_minutes: 7 }] }))).toThrow(
    'projects[0].project is missing or not a string',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, projects: ['p'] }))).toThrow('projects[0] is not an object')
  expect(() => parseExtracted(JSON.stringify({ ...good, sessions: [{ ...session('a', 3), text: undefined }] }))).toThrow(
    'sessions[0].text is missing or not a string',
  )
  expect(() => parseExtracted(JSON.stringify({ ...good, active_minutes: '7' }))).toThrow('active_minutes is missing or not a number')
  expect(() => parseExtracted('null')).toThrow('the result is not an object')
  expect(() => parseExtracted('[]')).toThrow('the result is not an object')
  expect(() => parseExtracted('not json')).toThrow('extract output is not JSON')
})

test('weekdayOf names the weekday of a calendar date, including across a month and a leap day', async () => {
  expect(weekdayOf('2026-10-05')).toBe('Monday')
  expect(weekdayOf('2026-10-06')).toBe('Tuesday')
  expect(weekdayOf('2026-10-11')).toBe('Sunday')
  expect(weekdayOf('2028-02-29')).toBe('Tuesday')
})

const runNames = (...days: string[]) => days.map(d => `${d}-run.json`)

test('a Monday report sums the Tuesday to Sunday runs of the week it closes, and not the previous Monday', async () => {
  const names = runNames('2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12')
  expect(weekRunDays(names, '2026-10-12')).toEqual(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
})

test('a Tuesday report picks no earlier run, since it covers the Monday that starts the week', async () => {
  expect(weekRunDays(runNames('2026-10-06', '2026-10-11', '2026-10-12'), '2026-10-13')).toEqual([])
})

test('a mid-week report picks the runs from Tuesday up to the day before its date', async () => {
  const names = runNames('2026-10-09', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16')
  expect(weekRunDays(names, '2026-10-15')).toEqual(['2026-10-13', '2026-10-14'])
  expect(weekRunDays(names, '2026-10-14')).toEqual(['2026-10-13'])
})

test('weekRunDays sorts its days and ignores names that are not a dated run record', async () => {
  const names = ['2026-10-08-run.json', '2026-10-07.md', 'notes-run.json', '2026-10-07-summaries.md', '2026-10-7-run.json', '2026-10-07-run.json.bak', '2026-10-07-run.json']
  expect(weekRunDays(names, '2026-10-09')).toEqual(['2026-10-07', '2026-10-08'])
})

test('parseRunRecord reads the active minutes and the per-project minutes of a run record', async () => {
  const projects = [{ project: '/a', active_minutes: 30 }]
  expect(parseRunRecord(JSON.stringify({ since: 's', activeMinutes: 45, projects }))).toEqual({ activeMinutes: 45, projects })
})

test('parseRunRecord gives an old run record without projects an empty project list', async () => {
  expect(parseRunRecord(JSON.stringify({ activeMinutes: 45 }))).toEqual({ activeMinutes: 45, projects: [] })
  expect(parseRunRecord(JSON.stringify({ activeMinutes: 45, projects: 'x' }))).toEqual({ activeMinutes: 45, projects: [] })
})

test('parseRunRecord drops a malformed project entry and keeps the good ones', async () => {
  const good = { project: '/a', active_minutes: 30 }
  const raw = JSON.stringify({ activeMinutes: 45, projects: [good, null, 'p', { project: '/b' }, { active_minutes: 3 }, { project: '/c', active_minutes: '9' }, 7] })
  expect(parseRunRecord(raw)).toEqual({ activeMinutes: 45, projects: [good] })
})

test('parseRunRecord returns undefined for text that is not JSON, not an object, or has no numeric activeMinutes', async () => {
  for (const raw of ['', 'not json', 'null', '[]', '7', '{}', JSON.stringify({ activeMinutes: '45' }), JSON.stringify({ active_minutes: 45 })]) {
    expect(parseRunRecord(raw)).toBeUndefined()
  }
})

test('weekToDate adds tonight to the earlier runs, per project too, with the most time first', async () => {
  const earlier = [
    { activeMinutes: 100, projects: [{ project: '/a', active_minutes: 40 }, { project: '/b', active_minutes: 60 }] },
    { activeMinutes: 30, projects: [{ project: '/a', active_minutes: 30 }] },
  ]
  const tonight: Extracted = { sessions: [], active_minutes: 50, projects: [{ project: '/c', active_minutes: 50 }, { project: '/a', active_minutes: 5 }] }
  expect(weekToDate(earlier, tonight)).toEqual({
    minutes: 180,
    projects: [
      { project: '/a', active_minutes: 75 },
      { project: '/b', active_minutes: 60 },
      { project: '/c', active_minutes: 50 },
    ],
  })
})

test('weekToDate with no earlier run is tonight alone, and a run with no projects still counts its minutes', async () => {
  const tonight: Extracted = { sessions: [], active_minutes: 20, projects: [{ project: '/a', active_minutes: 20 }] }
  expect(weekToDate([], tonight)).toEqual({ minutes: 20, projects: [{ project: '/a', active_minutes: 20 }] })
  expect(weekToDate([{ activeMinutes: 15, projects: [] }], tonight)).toEqual({ minutes: 35, projects: [{ project: '/a', active_minutes: 20 }] })
})

const FAST_TRACK = ['## Fast track', 'Do the thing.', '', '  ```', '  ## Not a heading', '  say hi', '  ```', 'after the fence']
const report = (...sections: string[][]) => sections.flat().join('\n')

test('historyBlock keeps the latest report whole and strips the Fast track from earlier ones', async () => {
  const body = report(['## Working on', 'x'], FAST_TRACK, ['## Questions', 'q?'])
  const block = historyBlock([
    { day: '2026-10-05', report: body, answers: 'a1' },
    { day: '2026-10-06', report: body, answers: undefined },
  ])
  const [first, second] = block.split('\n\n---\n\n')
  expect(first).toBe('## Report 2026-10-05\n## Working on\nx\n## Questions\nq?\n\n## Answers 2026-10-05\na1')
  expect(second).toBe(`## Report 2026-10-06\n${body}\n\n## Answers 2026-10-06\n(not answered)`)
})

test('a level-two line inside an indented code block does not end the Fast track section being dropped', async () => {
  const days: HistoryDay[] = [
    { day: '2026-10-05', report: report(['## Working on', 'x'], FAST_TRACK, ['## Questions', 'q?']), answers: '' },
    { day: '2026-10-06', report: 'latest', answers: '' },
  ]
  const block = historyBlock(days)
  expect(block).not.toContain('Not a heading')
  expect(block).not.toContain('after the fence')
  expect(block).toContain('## Questions\nq?')
})

test('a Fast track heading inside a code block of another section is left in place', async () => {
  const body = report(['## Notes', '```', '## Fast track', 'quoted', '```', 'tail'], ['## Questions', 'q?'])
  const block = historyBlock([{ day: '2026-10-05', report: body, answers: '' }, { day: '2026-10-06', report: 'latest', answers: '' }])
  expect(block).toContain('quoted')
  expect(block).toContain('tail')
})

test('a Fast track that is the last section of an earlier report is dropped to the end', async () => {
  const block = historyBlock([{ day: '2026-10-05', report: report(['## Questions', 'q?'], FAST_TRACK), answers: 'a' }, { day: '2026-10-06', report: 'latest', answers: 'b' }])
  expect(block.split('\n\n---\n\n')[0]).toBe('## Report 2026-10-05\n## Questions\nq?\n\n## Answers 2026-10-05\na')
})

test('historyBlock of no days is empty, and a sole report keeps its Fast track', async () => {
  expect(historyBlock([])).toBe('')
  expect(historyBlock([{ day: '2026-10-05', report: FAST_TRACK.join('\n'), answers: undefined }])).toContain('Do the thing.')
})

const reports = (n: number, over: Record<number, string> = {}): HistoryDay[] =>
  Array.from({ length: n }, (_, i) => ({ day: `d${i}`, report: over[i] ?? '## Questions\nq', answers: undefined }))

test('the week in review applies on a Monday report date only', async () => {
  expect(reportBlocks('2026-10-12', []).weekly).toBe(true)
  for (const day of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) {
    expect(reportBlocks(day, []).weekly).toBe(false)
  }
})

test('the Is this working check-in waits for 13 earlier reports', async () => {
  expect(reportBlocks('2026-10-13', reports(12)).day14).toBe(false)
  expect(reportBlocks('2026-10-13', reports(13)).day14).toBe(true)
  expect(reportBlocks('2026-10-13', reports(14)).day14).toBe(true)
})

test('the Is this working check-in is skipped when any of the last 7 reports holds it, but not the 8th from last', async () => {
  const has = `## Working on\nx\n${IS_THIS_WORKING}\nyes`
  expect(IS_THIS_WORKING).toBe('## Is this working?')
  expect(reportBlocks('2026-10-13', reports(14, { 13: has })).day14).toBe(false)
  expect(reportBlocks('2026-10-13', reports(14, { 7: has })).day14).toBe(false)
  expect(reportBlocks('2026-10-13', reports(14, { 6: has })).day14).toBe(true)
})

test('only a line that is exactly the Is this working heading blocks the check-in', async () => {
  for (const near of ['## Is this working? (draft)', 'Is this working?', '### Is this working?', 'see ## Is this working? above']) {
    expect(reportBlocks('2026-10-13', reports(14, { 13: near })).day14).toBe(true)
  }
})

test('answeredCount counts the reports that have an answers file, even an empty one', async () => {
  const days: HistoryDay[] = [
    { day: 'a', report: '', answers: 'x' },
    { day: 'b', report: '', answers: undefined },
    { day: 'c', report: '', answers: '' },
  ]
  expect(answeredCount(days)).toBe(2)
  expect(answeredCount([])).toBe(0)
})

test('factsBlock puts the extra lines after the not-summarized line, and none by default', async () => {
  const ex: Extracted = { sessions: [session('a', 1)], active_minutes: 60, projects: [{ project: '/p', active_minutes: 60 }] }
  const base = [
    '# Computed facts (from timestamps; use these, never sum session minutes yourself)',
    '- sessions: 1',
    '- active time across all sessions, overlaps counted once: 1.0h',
    '- time by project, overlaps within a project counted once:',
    '  - /p: 1.0h',
    '- sessions not summarized: 2',
  ]
  expect(factsBlock(ex, 2)).toBe(base.join('\n'))
  expect(factsBlock(ex, 2, ['- extra one', '- extra two'])).toBe([...base, '- extra one', '- extra two'].join('\n'))
})

const reportInput = () => ({
  today: '2026-10-12',
  since: 'S',
  until: 'U',
  extracted: { sessions: [session('a', 1)], active_minutes: 60, projects: [{ project: '/p', active_minutes: 60 }] } as Extracted,
  failed: 0,
  week: { minutes: 150, projects: [{ project: '/p', active_minutes: 90 }, { project: '/q', active_minutes: 60 }] },
  priorities: 'ship it',
  history: [{ day: '2026-10-11', report: 'R', answers: 'A' }] as HistoryDay[],
  summaries: ['## s1', '## s2'],
})

test('reportPrompt opens with the date and weekday, then the window with the earlier-report count', async () => {
  const lines = reportPrompt(reportInput()).split('\n\n')
  expect(lines[0]).toBe('Today is 2026-10-12 (Monday).')
  expect(lines[1]).toBe('Window: S → U. 1 earlier report on file.')
  expect(reportPrompt({ ...reportInput(), history: [] })).toContain('Window: S → U. 0 earlier reports on file.')
})

test('reportPrompt lists the week-to-date time and its projects inside the computed facts', async () => {
  const prompt = reportPrompt(reportInput())
  expect(prompt).toContain(
    [
      '- sessions not summarized: 0',
      '- active time this week, from Monday to the end of this window: 2.5h',
      '- time by project this week:',
      '  - /p: 1.5h',
      '  - /q: 1.0h',
    ].join('\n'),
  )
})

test('reportPrompt carries the priorities, the history, and the summaries under their headings', async () => {
  const prompt = reportPrompt(reportInput())
  expect(prompt).toContain('# Standing priorities\nship it')
  expect(prompt).toContain('only the latest keeps its Fast track)\n## Report 2026-10-11\nR\n\n## Answers 2026-10-11\nA')
  expect(prompt.endsWith('# Session summaries for the window\n## s1\n\n## s2')).toBe(true)
})

test('reportPrompt says so when there are no priorities, no earlier report, or no sessions', async () => {
  const prompt = reportPrompt({ ...reportInput(), priorities: '', history: [], summaries: [] })
  expect(prompt).toContain('# Standing priorities\n(none set)')
  expect(prompt).toContain('\n(none yet: this is the first report)')
  expect(prompt.endsWith('# Session summaries for the window\n(no sessions in the window)')).toBe(true)
})
