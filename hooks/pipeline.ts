export type Session = {
  id: string
  project: string
  start: string
  end: string
  typed: number
  active_minutes: number
  text: string
}

export type Summary = { ids: string[]; text: string } | { ids: string[]; failed: string }

export const DAY_MS = 24 * 3600_000
export const MAX_WINDOW_MS = 72 * 3600_000
export const FIRST_WINDOW_MS = DAY_MS
export const REPORTS_READ = 14
export const REMEMBER_FRESH_MS = 36 * 3600_000
export const BATCH_SMALL_CHARS = 3_000
export const BATCH_MAX_CHARS = 20_000

const DAY = /^(\d{4}-\d{2}-\d{2})\.md$/
const UNTIL = /\buntil (\d{4}-\d{2}-\d{2})\b/i
const REMEMBER = /^\s*\**One thing to remember all day:?\**:?\s*(.+?)\s*$/im

export function localDate(ms: number, offsetMinutes: number): string {
  return new Date(ms - offsetMinutes * 60_000).toISOString().slice(0, 10)
}

export type State = { watermark?: string; prevWatermark?: string; reportDate?: string }

export function parseState(raw: string): { state: State; corrupt: boolean } {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { state: {}, corrupt: true }
    const str = (k: string) => {
      const x = (v as Record<string, unknown>)[k]
      return typeof x === 'string' ? x : undefined
    }
    return {
      state: { watermark: str('watermark'), prevWatermark: str('prevWatermark'), reportDate: str('reportDate') },
      corrupt: false,
    }
  } catch {
    return { state: {}, corrupt: true }
  }
}

// A run on the day a report was already written redoes that report over the same window:
// prevWatermark is where the day's report window started.
export function windowForRun(state: State, nowMs: number, today: string) {
  const redo = state.reportDate === today && state.prevWatermark !== undefined
  return windowFor(redo ? state.prevWatermark : state.watermark, nowMs)
}

export function nextState(since: string, until: string, today: string): State {
  return { watermark: until, prevWatermark: since, reportDate: today }
}

export function windowFor(watermark: string | undefined, nowMs: number) {
  const last = watermark ? Date.parse(watermark) : NaN
  const sinceMs = Number.isNaN(last)
    ? nowMs - FIRST_WINDOW_MS
    : Math.max(last, nowMs - MAX_WINDOW_MS)
  return { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() }
}

export function activePriorities(text: string, today: string): string {
  return text
    .split('\n')
    .filter(line => {
      const m = UNTIL.exec(line)
      return !m?.[1] || m[1] >= today
    })
    .join('\n')
    .trim()
}

export function reportDays(names: readonly string[], today: string): string[] {
  return names
    .map(n => DAY.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && d < today)
    .sort()
    .slice(-REPORTS_READ)
}

export function batchSessions(sessions: readonly Session[]): Session[][] {
  const batches: Session[][] = []
  let small: Session[] = []
  let size = 0
  for (const s of sessions) {
    if (s.text.length >= BATCH_SMALL_CHARS) {
      batches.push([s])
      continue
    }
    if (size + s.text.length > BATCH_MAX_CHARS && small.length) {
      batches.push(small)
      small = []
      size = 0
    }
    small.push(s)
    size += s.text.length
  }
  if (small.length) batches.push(small)
  return batches
}

export function sessionBlock(s: Session): string {
  return `### session ${s.id}\nproject: ${s.project}\nspan: ${s.start} → ${s.end}\nyour active minutes (computed from your message times): ${s.active_minutes}\n\n${s.text}`
}

export function rememberLine(report: string): string | undefined {
  return REMEMBER.exec(report)?.[1]?.replace(/\*+$/, '').trim() || undefined
}

// Once one item rejects, no lane starts another; items already running finish.
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await work(items[i]!)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

export type CallFailure = { reason: string; status?: number | null; error?: string }

// Errors no wait will clear: retrying only repeats them, so the run stops at the first one.
const PERMANENT_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
  'invalid_request',
  'model_not_found',
])

export const RETRY_DELAYS_S = [30, 60, 120, 240] as const

export function isPermanent(f: CallFailure): boolean {
  return f.error !== undefined && PERMANENT_ERRORS.has(f.error)
}

// Seconds to wait before retry number `attempt` (0-based), or undefined to give up.
// Rate limits, overload, server errors and dropped connections back off and retry;
// a timed-out call gets one retry, since a second timeout costs another full wait.
export function retryDelayS(f: CallFailure, attempt: number): number | undefined {
  if (isPermanent(f)) return undefined
  if (f.reason === 'aborted') return attempt === 0 ? RETRY_DELAYS_S[0] : undefined
  return RETRY_DELAYS_S[attempt]
}

// The report is still worth writing when most sessions were summarized.
export function tooManyFailed(total: number, failed: number): boolean {
  return total > 0 && failed * 2 > total
}

// Counts sessions, not summary calls: one failed call can hold a batch of several sessions.
export function summaryOutcome(summaries: readonly Summary[]): { failed: number; text: string[] } {
  const sessions = (list: readonly Summary[]) => list.reduce((n, s) => n + s.ids.length, 0)
  const failures = summaries.filter((s): s is Extract<Summary, { failed: string }> => 'failed' in s)
  const failed = sessions(failures)
  const total = sessions(summaries)
  if (tooManyFailed(total, failed)) throw new Error(`${failed} of ${total} summaries failed: ${failures[0]!.failed}`)
  const text = summaries.map(s => ('text' in s ? s.text : `## ${s.ids.join(', ')} — not summarized (${s.failed})`))
  return { failed, text }
}

export function notSummarized(failed: number): string {
  return failed ? ` (${plural(failed, 'session')} not summarized)` : ''
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type UsageByModel = Record<string, Usage & { calls: number }>

export function addUsage(acc: UsageByModel, model: string, u: Usage): void {
  const cur = (acc[model] ??= {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  cur.calls += 1
  cur.input_tokens += u.input_tokens
  cur.output_tokens += u.output_tokens
  cur.cache_read_input_tokens += u.cache_read_input_tokens
  cur.cache_creation_input_tokens += u.cache_creation_input_tokens
}

export function describeFailure(model: string, f: CallFailure): string {
  const detail = [f.status, f.error].filter(x => x !== undefined && x !== null).join(' ')
  return `${model} call failed: ${f.reason}${detail ? ` ${detail}` : ''}`
}

export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

// What /morning-review tells its session about starting a fast-track item: the configured command, or
// a paste-ready block when none is set.
export function launchInstruction(command: string): string {
  if (!command.trim()) {
    return 'no launch command is set, so print each filled prompt in a code block under a `cd <repo path> && claude` line for me to paste.'
  }
  return [
    `run \`${command}\` with Bash, once per item, where \`{dir}\` is the item's repo path (expand \`~\`),`,
    '`{name}` is the item in 2-4 lowercase kebab-case words plus `-` and 4 random hex characters (`openssl rand -hex 2`),',
    'and `{prompt}` is the filled prompt passed as one single-quoted shell argument. Show me what each launch printed.',
  ].join(' ')
}

export type RunArgs = { force: boolean; backfill?: { date: string; since: string; until: string } }

// `/morning-run [--force] [--backfill YYYY-MM-DD --until ISO]`: a backfill writes a past day's
// report over the 24h before `until`, and leaves the watermark and the remember line alone.
export function parseRunArgs(args: string): RunArgs {
  const force = /(^|\s)--force\b/.test(args)
  const date = /--backfill\s+(\d{4}-\d{2}-\d{2})\b/.exec(args)?.[1]
  const until = /--until\s+(\S+)/.exec(args)?.[1]
  if (date === undefined) return { force }
  const untilMs = until === undefined ? NaN : Date.parse(until)
  if (Number.isNaN(untilMs)) throw new Error('--backfill needs --until <ISO time>')
  return {
    force,
    backfill: { date, since: new Date(untilMs - FIRST_WINDOW_MS).toISOString(), until: new Date(untilMs).toISOString() },
  }
}

export type ProjectMinutes = { project: string; active_minutes: number }
export type Extracted = { sessions: Session[]; active_minutes: number; projects: ProjectMinutes[] }

type JsonObject = Record<string, unknown>

function objectAt(value: unknown, at: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`extract output: ${at} is not an object`)
  return value as JsonObject
}

function arrayAt(o: JsonObject, key: string, at: string): unknown[] {
  const value = o[key]
  if (!Array.isArray(value)) throw new Error(`extract output: ${at}${key} is missing or not an array`)
  return value
}

function fieldsAt(o: JsonObject, types: Readonly<Record<string, 'string' | 'number'>>, at: string): void {
  for (const [key, type] of Object.entries(types)) {
    if (typeof o[key] !== type) throw new Error(`extract output: ${at}${key} is missing or not a ${type}`)
  }
}

const SESSION_FIELDS = { id: 'string', project: 'string', start: 'string', end: 'string', typed: 'number', active_minutes: 'number', text: 'string' } as const
const PROJECT_FIELDS = { project: 'string', active_minutes: 'number' } as const

export function parseExtracted(stdout: string): Extracted {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (err) {
    throw new Error(`extract output is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const top = objectAt(value, 'the result')
  arrayAt(top, 'sessions', '').forEach((s, i) => fieldsAt(objectAt(s, `sessions[${i}]`), SESSION_FIELDS, `sessions[${i}].`))
  fieldsAt(top, { active_minutes: 'number' }, '')
  arrayAt(top, 'projects', '').forEach((p, i) => fieldsAt(objectAt(p, `projects[${i}]`), PROJECT_FIELDS, `projects[${i}].`))
  return top as Extracted
}

export const PROFILE_HEADINGS = [
  { heading: 'Working on', holds: 'what they are doing or working toward, right now' },
  { heading: 'What the report is for', holds: 'what they want to read first each morning' },
  { heading: 'Counts as progress', holds: 'what moves it, and what is background' },
  { heading: 'Watch for', holds: 'what the report should notice across days, if anything' },
  { heading: 'Track', holds: 'limits or regular outputs to hold to, if any' },
] as const

export function profileHeadingsBlock(): string {
  return PROFILE_HEADINGS.map(h => `## ${h.heading} — ${h.holds}`).join('\n')
}

export const SCAN_TOOL = 'morning_setup_scan'

// The `{{KEY}}` slots each prompt file holds, which its hook fills; a test binds this to the files.
export const PROMPT_FILLS = {
  'report.md': ['PROFILE'],
  'report-weekly.md': [],
  'report-day14.md': ['ANSWERED'],
  'summarizer.md': ['PROFILE'],
  'setup-scan.md': [],
  'morning-setup.md': ['DATA_DIR', 'TODAY', 'PREVIEW', 'PROFILE_HEADINGS', 'PROFILE'],
  'morning-review.md': ['DATA_DIR', 'TODAY', 'LAUNCH'],
} as const

export type PromptName = keyof typeof PROMPT_FILLS
export type PromptValues<N extends PromptName> = Record<(typeof PROMPT_FILLS)[N][number], string>

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

// One pass, so a value that itself holds `{{KEY}}` is never filled again.
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => (Object.hasOwn(values, key) ? values[key]! : match))
}

export type IntBounds = { min: number; max: number; fallback: number }
export const SETUP_DAYS: IntBounds = { min: 1, max: 7, fallback: 7 }
export const REPORT_FIRES = 5
export const REPORT_HOUR: IntBounds = { min: 0, max: 24 - REPORT_FIRES, fallback: 5 }

export function intOption(value: unknown, bounds: IntBounds): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
}

const STDERR_HEAD_CHARS = 200

export function stderrHead(stderr: string): string {
  return stderr.trim().slice(0, STDERR_HEAD_CHARS)
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function consentLine(sessions: number, batches: number, days: number, summaryModel: string, reportModel: string): string {
  return `${plural(sessions, 'session')} over the last ${plural(days, 'day')}: ${plural(batches, 'summary call')} on ${summaryModel}, then 1 ${reportModel} call`
}

// What the hook fills into a prompt in place of a missing input. Each prompt branches on this text.
export const SETUP_NO_PROFILE = '(none yet)'
export const SUMMARY_NO_PROFILE = '(no profile yet)'
export const SCAN_NO_SESSIONS = '(no sessions'

export function noSessionsScan(days: number): string {
  return `${SCAN_NO_SESSIONS} in the last ${plural(days, 'day')})`
}

export const SCAN_UNREADABLE = `${SCAN_NO_SESSIONS} read: the sessions could not be read)`

export const SETUP_ARGUMENT_HINT = '[schedule | remove]'
export const SETUP_USAGE = `usage: /morning-setup ${SETUP_ARGUMENT_HINT}`

export type SetupArgs = { kind: 'interview' } | { kind: 'schedule' } | { kind: 'remove' } | { kind: 'usage' }

const SETUP_WORDS = ['schedule', 'remove'] as const

export function parseSetupArgs(args: string): SetupArgs {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'interview' }
  const word = words.length === 1 ? SETUP_WORDS.find(w => w === words[0]) : undefined
  return word === undefined ? { kind: 'usage' } : { kind: word }
}

export type LaunchdNames = { label: string; plist: string; logDir: string; log: string; domain: string; target: string }

const LAUNCHD_LABEL = 'com.morning-report'

export function launchdNames(home: string, uid: string): LaunchdNames {
  const logDir = `${home}/Library/Logs/${LAUNCHD_LABEL}`
  return {
    label: LAUNCHD_LABEL,
    plist: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    logDir,
    log: `${logDir}/run.log`,
    domain: `gui/${uid}`,
    target: `gui/${uid}/${LAUNCHD_LABEL}`,
  }
}

export function isMacOS(unameS: string): boolean {
  return unameS.trim() === 'Darwin'
}

export const MANUAL_RUN_TEXT =
  'scheduled runs are macOS only; run `claude -p /morning-run` each morning by hand, or put that command in your own scheduler'

export type PlistInput = { claudePath: string; home: string; path: string; uid: string; hour: number; pluginName: string }

function shellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

function xmlString(text: string): string {
  return `<string>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
}

// Reads `claude plugin list --json` on stdin and prints enabled, disabled or absent for the plugin
// named in argv[1]. Anything but a list of plugins exits non-zero, so a failed list never reads as absent.
const PLUGIN_STATE_PY = `import json, sys
plugins = json.load(sys.stdin)
if not (isinstance(plugins, list) and all(isinstance(p, dict) and isinstance(p.get("id"), str) and isinstance(p.get("enabled"), bool) for p in plugins)):
    sys.exit("claude plugin list --json printed no plugin list")
mine = [p["enabled"] for p in plugins if p["id"].startswith(sys.argv[1] + "@")]
state = "enabled" if any(mine) else "disabled" if mine else "absent"
print(state)`

const jobEnv = (home: string, path: string): [string, string][] => [
  ['HOME', home],
  ['PATH', path],
]

// Login variables launchd sets that the run's tools use (the ssh agent for a push, the temp folder); none picks a config.
const JOB_PASSTHROUGH = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'SSH_AUTH_SOCK']

// launchd hands a job every variable of its domain (`launchctl setenv`) besides the plist's, and many
// variables change what claude reads (CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_DIRS, …). `env -i` drops them
// all, so the job and the schedule hook's check, both started through this, see one environment.
// The script rides as the outer shell's $1, so it stays as written.
function jobArgv(home: string, path: string, script: string): string[] {
  const keep = JOB_PASSTHROUGH.map(name => `\${${name}+"${name}=$${name}"}`)
  const set = jobEnv(home, path).map(([k, v]) => shellWord(`${k}=${v}`))
  const reset = ['exec', '/usr/bin/env', '-i', ...keep, ...set, '/bin/sh', '-c', '"$1"'].join(' ')
  return ['/bin/sh', '-c', reset, 'morning-report', script]
}

// Sets `state` from the plugin list, or exits 1 when the list fails or cannot be read.
function pluginStateLines(claudePath: string, pluginName: string): string[] {
  return [
    `list=$(${shellWord(claudePath)} plugin list --json) || { echo "morning-report: claude plugin list failed (exit $?); the job stays" >&2; exit 1; }`,
    `state=$(printf '%s' "$list" | python3 -c ${shellWord(PLUGIN_STATE_PY)} ${shellWord(pluginName)}) || { echo "morning-report: could not read claude plugin list; the job stays" >&2; exit 1; }`,
  ]
}

export type JobPluginCheck = { argv: string[]; cwd: string }

// The job's own plugin check, run where and with the environment the job runs in; prints the state.
export function jobPluginCheck({ claudePath, home, path, pluginName }: Omit<PlistInput, 'uid' | 'hour'>): JobPluginCheck {
  const script = [...pluginStateLines(claudePath, pluginName), `printf '%s\\n' "$state"`].join('; ')
  return { argv: jobArgv(home, path, script), cwd: home }
}

// The job runs the report only while the plugin is enabled, and removes itself only when a
// successful list lacks the plugin. `rm` goes before `bootout` because bootout kills this shell,
// so the log line that says why goes first of all.
export function renderPlist({ claudePath, home, path, uid, hour, pluginName }: PlistInput): string {
  const names = launchdNames(home, uid)
  const removing = `morning-report: claude plugin list --json does not list ${pluginName}; removing this job: rm -f ${names.plist}, then launchctl bootout ${names.target}`
  const script = [
    ...pluginStateLines(claudePath, pluginName),
    `if [ "$state" = enabled ]; then exec ${shellWord(claudePath)} -p /morning-run`,
    `elif [ "$state" != absent ]; then echo "morning-report: the plugin is $state; nothing run" >&2`,
    `else echo ${shellWord(removing)} >&2`,
    `rm -f ${shellWord(names.plist)} || exit 1`,
    `launchctl bootout ${shellWord(names.target)}`,
    'fi',
  ].join('; ')
  const fires = Array.from(
    { length: REPORT_FIRES },
    (_, i) => `    <dict><key>Hour</key><integer>${hour + i}</integer><key>Minute</key><integer>0</integer></dict>`,
  )
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${xmlString(names.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...jobArgv(home, path, script).map(arg => `    ${xmlString(arg)}`),
    '  </array>',
    `  <key>WorkingDirectory</key>${xmlString(home)}`,
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...fires,
    '  </array>',
    '  <key>RunAtLoad</key><false/>',
    `  <key>StandardInPath</key>${xmlString('/dev/null')}`,
    `  <key>StandardOutPath</key>${xmlString(names.log)}`,
    `  <key>StandardErrorPath</key>${xmlString(names.log)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...jobEnv(home, path).map(([k, v]) => `    <key>${k}</key>${xmlString(v)}`),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export function hours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`
}

export const COMPUTED_FACTS = '# Computed facts (from timestamps; use these, never sum session minutes yourself)'

function projectLines(projects: readonly ProjectMinutes[]): string[] {
  return projects.map(p => `  - ${p.project}: ${hours(p.active_minutes)}`)
}

export function factsBlock(extracted: Extracted, failed: number, extra: readonly string[] = []): string {
  return [
    COMPUTED_FACTS,
    `- sessions: ${extracted.sessions.length}`,
    `- active time across all sessions, overlaps counted once: ${hours(extracted.active_minutes)}`,
    '- time by project, overlaps within a project counted once:',
    ...projectLines(extracted.projects),
    `- sessions not summarized: ${failed}`,
    ...extra,
  ].join('\n')
}

export type ScanInput = {
  since: string
  until: string
  days: number
  extracted: Extracted
  failed: number
  summaries: readonly string[]
}

export function scanPrompt({ since, until, days, extracted, failed, summaries }: ScanInput): string {
  return [
    `Window: ${since} → ${until} (${plural(days, 'day')}).`,
    factsBlock(extracted, failed),
    `# Session summaries\n${summaries.join('\n\n')}`,
  ].join('\n\n')
}

const RUN_RECORD = /^(\d{4}-\d{2}-\d{2})-run\.json$/

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function weekdayOf(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
}

// A report covers the day before its date, so the week a report counts runs from the Monday on or
// before that day: report dates Tuesday through the next Monday.
export function weekRunDays(names: readonly string[], today: string): string[] {
  const covered = addDays(today, -1)
  const monday = addDays(covered, -((new Date(`${covered}T00:00:00Z`).getUTCDay() + 6) % 7))
  const first = addDays(monday, 1)
  return names
    .map(n => RUN_RECORD.exec(n)?.[1])
    .filter((d): d is string => d !== undefined && d >= first && d < today)
    .sort()
}

function isProjectMinutes(p: unknown): p is ProjectMinutes {
  if (typeof p !== 'object' || p === null) return false
  const o = p as JsonObject
  return typeof o.project === 'string' && typeof o.active_minutes === 'number'
}

export type RunRecord = { activeMinutes: number; projects: ProjectMinutes[] }

// An unreadable record counts as nothing rather than failing the report it only adds a line to.
export function parseRunRecord(raw: string): RunRecord | undefined {
  try {
    const v = objectAt(JSON.parse(raw), 'run record')
    if (typeof v.activeMinutes !== 'number') return undefined
    const projects = Array.isArray(v.projects) ? v.projects.filter(isProjectMinutes) : []
    return { activeMinutes: v.activeMinutes, projects }
  } catch {
    return undefined
  }
}

export type WeekToDate = { minutes: number; projects: ProjectMinutes[] }

export function weekToDate(earlier: readonly RunRecord[], tonight: Extracted): WeekToDate {
  const runs = [...earlier, { activeMinutes: tonight.active_minutes, projects: tonight.projects }]
  const byProject = new Map<string, number>()
  for (const run of runs) {
    for (const p of run.projects) byProject.set(p.project, (byProject.get(p.project) ?? 0) + p.active_minutes)
  }
  return {
    minutes: runs.reduce((n, r) => n + r.activeMinutes, 0),
    projects: [...byProject]
      .map(([project, active_minutes]) => ({ project, active_minutes }))
      .sort((a, b) => b.active_minutes - a.active_minutes || a.project.localeCompare(b.project)),
  }
}

function weekLines(week: WeekToDate): string[] {
  return [
    `- active time this week, from Monday to the end of this window: ${hours(week.minutes)}`,
    '- time by project this week:',
    ...projectLines(week.projects),
  ]
}

export type HistoryDay = { day: string; report: string; answers: string | undefined }

const FENCE = /^\s*(```|~~~)/
const H2 = /^## /

// The section from `## <heading>` up to the next level-two heading outside a code block, dropped.
function withoutSection(markdown: string, heading: string): string {
  const out: string[] = []
  let dropping = false
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (!fenced && H2.test(line)) dropping = line.trim() === `## ${heading}`
    if (FENCE.test(line)) fenced = !fenced
    if (!dropping) out.push(line)
  }
  return out.join('\n')
}

// Earlier fast tracks were for their own morning; only the latest one is still on the table.
export function historyBlock(days: readonly HistoryDay[]): string {
  return days
    .map((d, i) => {
      const report = i === days.length - 1 ? d.report : withoutSection(d.report, 'Fast track')
      return `## Report ${d.day}\n${report.trim()}\n\n## Answers ${d.day}\n${d.answers ?? '(not answered)'}`
    })
    .join('\n\n---\n\n')
}

export const IS_THIS_WORKING = '## Is this working?'
const DAY14_AFTER = 13
const DAY14_EVERY = 7

export type ReportBlocks = { weekly: boolean; day14: boolean }

// Which conditional parts of the report prompt apply today: the week in review on Mondays, and the
// "Is this working?" check-in once enough reports exist and none of the recent ones holds it.
export function reportBlocks(today: string, history: readonly HistoryDay[]): ReportBlocks {
  const recent = history.slice(-DAY14_EVERY)
  return {
    weekly: weekdayOf(today) === 'Monday',
    day14: history.length >= DAY14_AFTER && !recent.some(d => d.report.split('\n').some(l => l.trim() === IS_THIS_WORKING)),
  }
}

export function answeredCount(history: readonly HistoryDay[]): number {
  return history.filter(d => d.answers !== undefined).length
}

export type ReportInput = {
  today: string
  since: string
  until: string
  extracted: Extracted
  failed: number
  week: WeekToDate
  priorities: string
  history: readonly HistoryDay[]
  summaries: readonly string[]
}

export function reportPrompt({ today, since, until, extracted, failed, week, priorities, history, summaries }: ReportInput): string {
  return [
    `Today is ${today} (${weekdayOf(today)}).`,
    `Window: ${since} → ${until}. ${plural(history.length, 'earlier report')} on file.`,
    factsBlock(extracted, failed, weekLines(week)),
    `# Standing priorities\n${priorities || '(none set)'}`,
    `# Earlier reports and answers, oldest first (only the latest keeps its Fast track)\n${historyBlock(history) || '(none yet: this is the first report)'}`,
    `# Session summaries for the window\n${summaries.join('\n\n') || '(no sessions in the window)'}`,
  ].join('\n\n')
}

// The scan model has no slot for missing summaries, so the file itself says what it covers.
export function scanFileText(scan: string, failed: number, sessions: number): string {
  const partial = failed
    ? `\n${failed} of ${plural(sessions, 'session')} could not be summarized, so Streams seen and Habits cover only part of the window; Time by project counts every session.\n`
    : ''
  return scan.trim() + '\n' + partial
}
