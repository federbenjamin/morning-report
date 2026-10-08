import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, ProcessRunResult, Register } from 'claude-code'
import {
  activePriorities,
  batchSessions,
  COMPUTED_FACTS,
  consentLine,
  describeFailure,
  expandHome,
  fillTemplate,
  hours,
  intOption,
  isMacOS,
  jobPluginCheck,
  launchdNames,
  launchInstruction,
  localDate,
  MANUAL_RUN_TEXT,
  nextState,
  noSessionsScan,
  notSummarized,
  parseExtracted,
  parseSetupArgs,
  parseRunArgs,
  parseState,
  pool,
  profileHeadingsBlock,
  REMEMBER_FRESH_MS,
  rememberLine,
  renderPlist,
  REPORT_FIRES,
  REPORT_HOUR,
  reportDays,
  scanFileText,
  SCAN_UNREADABLE,
  scanPrompt,
  sessionBlock,
  SETUP_ARGUMENT_HINT,
  SETUP_DAYS,
  SETUP_NO_PROFILE,
  SETUP_USAGE,
  stderrHead,
  SUMMARY_NO_PROFILE,
  summaryOutcome,
  addUsage,
  isPermanent,
  retryDelayS,
  windowForRun,
  type Extracted,
  type UsageByModel,
  type RunArgs,
  type Session,
  type Summary,
} from './pipeline'

// The remember line, drawn in a band above the prompt: a status entry is one line and cuts it off.
const remember = atom({ plugin: 'morning-report', key: 'remember' } as const, null)

const SUMMARY_CONCURRENCY = 12
const SUMMARY_TIMEOUT_MS = 300_000
const REPORT_TIMEOUT_MS = 600_000
// The report model's thinking counts against this cap; 16000 cut a report mid-sentence.
const REPORT_MAX_TOKENS = 32_000
const EXTRACT_TIMEOUT_MS = 300_000
const SHORT_PROCESS_TIMEOUT_MS = 60_000
// What `launchctl print` exits with when the domain holds no such service.
const LAUNCHCTL_NO_SERVICE = 113
const DAY_MS = 24 * 3600_000
const SCAN_TOOL = 'morning_setup_scan'

let scanRunning = false

type Config = {
  dataDir: string
  summaryModel: string
  reportModel: string
  sessionLogsDir: string
  notifyCommand: string
  launchCommand: string
  gitCommit: boolean
  setupDays: number
  home: string
  reportHour: number
}

// The trimmed stdout, or '' when the command failed, so a caller checks one value.
async function readLine($: EngineInterface, argv: string[]): Promise<string> {
  const r = await $.process.run(argv)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

async function resolveConfig($: EngineInterface, options: PluginOptions): Promise<Config> {
  const home = (await $.env.get('HOME')) ?? ''
  const str = (key: string, fallback: string) =>
    typeof options[key] === 'string' ? (options[key] as string) : fallback
  return {
    dataDir: expandHome(str('dataDir', '~/.morning-report'), home).replace(/\/$/, ''),
    summaryModel: str('summaryModel', 'sonnet'),
    reportModel: str('reportModel', 'opus'),
    sessionLogsDir: expandHome(str('sessionLogsDir', ''), home),
    notifyCommand: str('notifyCommand', ''),
    launchCommand: str('launchCommand', ''),
    gitCommit: options.gitCommit === true,
    setupDays: intOption(options.setupDays, SETUP_DAYS),
    home,
    reportHour: intOption(options.reportHour, REPORT_HOUR),
  }
}

async function readOr($: EngineInterface, path: string, fallback: string): Promise<string> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : fallback
}

async function readPrompt($: EngineInterface, name: string): Promise<string> {
  return String(await $.fs.read(`${$.plugin.root}/prompts/${name}`))
}

async function readProfile($: EngineInterface, cfg: Config): Promise<string | undefined> {
  return (await readOr($, `${cfg.dataDir}/profile.md`, '')).trim() || undefined
}

// Commits everything under dataDir (a folder of a git repo) and pushes. A failure is reported,
// never fatal: the report is already written.
async function commitData($: EngineInterface, cfg: Config, message: string): Promise<string> {
  const git = (...args: string[]) => $.process.run(['git', '-C', cfg.dataDir, ...args], { timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
  const add = await git('add', '-A', '--', '.')
  if (add.exitCode !== 0) return `git add failed: ${stderrHead(add.stderr)}`
  const staged = await git('diff', '--cached', '--quiet', '--', '.')
  if (staged.exitCode === 0) return 'nothing new to commit'
  const commit = await git('commit', '-q', '-m', message, '--', '.')
  if (commit.exitCode !== 0) return `git commit failed: ${stderrHead(commit.stderr)}`
  const push = await git('push', '-q')
  return push.exitCode === 0 ? 'committed and pushed' : `committed; push failed: ${stderrHead(push.stderr)}`
}

async function notify($: EngineInterface, cfg: Config, message: string) {
  if (cfg.notifyCommand) await $.process.run([cfg.notifyCommand, message]).catch(() => undefined)
}

type CompleteRequest = { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }

class PermanentFailure extends Error {}

// Retries back off with a `sleep` child process: a $ call in flight doesn't count against the
// hook's 10 s budget, where a $.clock.sleep would.
async function complete($: EngineInterface, req: CompleteRequest, usage: UsageByModel): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await $.model.complete(req)
    addUsage(usage, req.model, r.usage)
    if (r.isAnswered) return r.text
    const delay = retryDelayS(r, attempt)
    if (delay === undefined) {
      const message = describeFailure(req.model, r)
      throw isPermanent(r) ? new PermanentFailure(message) : new Error(message)
    }
    await $.process.run(['sleep', String(delay)], { timeoutMs: (delay + 10) * 1000 })
  }
}

// A session whose summary still fails after retries is reported as missing; a permanent
// error (auth, billing, a bad model id) rethrows, which stops the pool.
async function summarize(
  $: EngineInterface,
  cfg: Config,
  system: string,
  batch: Session[],
  usage: UsageByModel,
): Promise<Summary> {
  const ids = batch.map(s => s.id)
  const req: CompleteRequest = {
    model: cfg.summaryModel,
    system,
    prompt: batch.map(sessionBlock).join('\n\n'),
    maxTokens: Math.min(1500 * batch.length, 8000),
    timeoutMs: SUMMARY_TIMEOUT_MS,
  }
  try {
    return { ids, text: await complete($, req, usage) }
  } catch (err) {
    if (err instanceof PermanentFailure) throw err
    return { ids, failed: err instanceof Error ? err.message : String(err) }
  }
}

async function extractWindow($: EngineInterface, cfg: Config, since: string, until: string): Promise<Extracted> {
  const argv = ['python3', `${$.plugin.root}/scripts/extract.py`, '--since', since, '--until', until]
  if (cfg.sessionLogsDir) argv.push('--session-logs', cfg.sessionLogsDir)
  const ex = await $.process.run(argv, { timeoutMs: EXTRACT_TIMEOUT_MS })
  if (ex.exitCode !== 0) throw new Error(`extract failed: ${ex.stderr.slice(0, 300)}`)
  if (ex.isStdoutTruncated) throw new Error('extract output was cut at 4 MiB; lower OUTPUT_CAP in scripts/extract.py')
  return parseExtracted(ex.stdout)
}

async function summarizeSessions(
  $: EngineInterface,
  cfg: Config,
  system: string,
  sessions: Session[],
  usage: UsageByModel,
  onBatch?: (done: number, total: number) => void,
): Promise<{ failed: number; text: string[] }> {
  const batches = batchSessions(sessions)
  let done = 0
  const summaries = await pool(batches, SUMMARY_CONCURRENCY, async b => {
    const summary = await summarize($, cfg, system, b, usage)
    onBatch?.(++done, batches.length)
    return summary
  })
  return summaryOutcome(summaries)
}

// A command.run hook can't submit (the submit would wait on the turn the hook holds), so a
// timer submits once the command has returned.
function submitPrompt($: EngineInterface, command: string, text: string): void {
  const say = (message: string) => {
    try {
      $.ui.toast(`morning-report: ${message}`)
    } catch {
      // the hook's $ may be gone by the time the submit settles
    }
  }
  $.clock.after(0, () => {
    $.prompt.submit({ text }).then(
      r => {
        if (r.drop !== undefined) say(`/${command} prompt was dropped: ${r.drop}`)
      },
      (err: unknown) => say(`/${command} prompt failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  })
}

type MorningResult = { text: string; status?: { line: string | undefined } }

async function runMorning($: EngineInterface, cfg: Config, args: RunArgs): Promise<MorningResult> {
  const { force, backfill } = args
  const startedAt = Date.now()
  const now = backfill ? Date.parse(backfill.until) : startedAt
  const today = backfill?.date ?? localDate(now, new Date(now).getTimezoneOffset())
  const reportPath = `${cfg.dataDir}/${today}.md`
  if (!force && (await $.fs.exists(reportPath))) {
    return { text: `${today} already written (${reportPath}); /morning-run --force redoes it` }
  }
  await $.process.run(['mkdir', '-p', cfg.dataDir])

  const statePath = `${cfg.dataDir}/state.json`
  let since = '(not read)'
  let note = ''
  try {
    const parsed = parseState(await readOr($, statePath, '{}'))
    if (parsed.corrupt) note = ` (state.json was unreadable; used the default window)`
    const window = backfill ?? windowForRun(parsed.state, now, today)
    since = window.since
    const { until } = window

    const profile = await readProfile($, cfg)
    if (profile === undefined) throw new Error(`no profile at ${cfg.dataDir}/profile.md`)

    const extracted = await extractWindow($, cfg, since, until)
    const { sessions } = extracted

    const usage: UsageByModel = {}
    const summarizer = fillTemplate(await readPrompt($, 'summarizer.md'), { PROFILE: profile })
    const { failed, text: summaryText } = await summarizeSessions($, cfg, summarizer, sessions, usage)

    const names = (await $.fs.list(cfg.dataDir)).map(e => e.name)
    const history: string[] = []
    for (const day of reportDays(names, today)) {
      const answers = await readOr($, `${cfg.dataDir}/${day}-answers.md`, '(not answered)')
      history.push(`## Report ${day}\n${await $.fs.read(`${cfg.dataDir}/${day}.md`)}\n\n## Answers ${day}\n${answers}`)
    }
    const priorities = activePriorities(await readOr($, `${cfg.dataDir}/priorities.md`, ''), today)

    const report = await complete($, {
      model: cfg.reportModel,
      system: fillTemplate(await readPrompt($, 'report.md'), { PROFILE: profile }),
      prompt: [
        `Today is ${today} (${new Date(now).toLocaleDateString('en-US', { weekday: 'long' })}).`,
        `Window: ${since} → ${until}. ${history.length} earlier reports on file.`,
        `${COMPUTED_FACTS}\n- sessions: ${sessions.length}\n- your active time across all sessions, overlaps counted once: ${hours(extracted.active_minutes)}\n- sessions not summarized: ${failed}`,
        `# Standing priorities\n${priorities || '(none set)'}`,
        `# Earlier reports and answers, oldest first\n${history.join('\n\n---\n\n') || '(none yet: this is the first report)'}`,
        `# Session summaries for the window\n${summaryText.join('\n\n') || '(no sessions in the window)'}`,
      ].join('\n\n'),
      maxTokens: REPORT_MAX_TOKENS,
      timeoutMs: REPORT_TIMEOUT_MS,
    }, usage)

    const runsDir = `${cfg.dataDir}/runs`
    await $.process.run(['mkdir', '-p', runsDir])
    await $.fs.write(`${runsDir}/${today}-summaries.md`, summaryText.join('\n\n') + '\n')
    await $.fs.write(
      `${runsDir}/${today}-run.json`,
      JSON.stringify({ since, until, sessions: sessions.length, activeMinutes: extracted.active_minutes, failed, seconds: Math.round((Date.now() - startedAt) / 1000), usage }, null, 2) + '\n',
    )

    // The remember line is the report's last line: without it the report was cut off, and a
    // partial report must not replace a whole one or advance the watermark.
    const remember = rememberLine(report)
    if (!remember) throw new Error('the report came back without its last line (cut off at the token cap?); nothing written')
    await $.fs.write(reportPath, report.trim() + '\n')
    const saved = cfg.gitCommit ? `; ${await commitData($, cfg, `morning: ${today}${backfill ? ' (backfill)' : ''}`)}` : ''
    if (backfill) return { text: `backfilled ${reportPath}${notSummarized(failed)}${saved}` }
    await $.fs.write(`${cfg.dataDir}/remember.txt`, remember + '\n')
    await $.fs.write(statePath, JSON.stringify(nextState(since, until, today)) + '\n')
    await notify($, cfg, `Morning report ready (${sessions.length} sessions) — run /morning-review`)
    return { text: `wrote ${reportPath}${notSummarized(failed)}${saved}${note}`, status: { line: remember } }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (!backfill) await notify($, cfg, `Morning report failed: ${reason}`)
    return { text: `failed: ${reason} (window kept from ${since})${note}` }
  }
}

async function freshRemember($: EngineInterface, cfg: Config): Promise<string | undefined> {
  const path = `${cfg.dataDir}/remember.txt`
  if (!(await $.fs.exists(path))) return undefined
  const { mtimeMs } = await $.fs.stat(path)
  if (Date.now() - mtimeMs > REMEMBER_FRESH_MS) return undefined
  return String(await $.fs.read(path)).trim() || undefined
}

type SetupWindow = { since: string; until: string; extracted: Extracted; consent: string }

// The window, its extract and the consent line, before any model call; undefined when it has no sessions.
async function setupWindow($: EngineInterface, cfg: Config, days: number): Promise<SetupWindow | undefined> {
  const now = Date.now()
  const since = new Date(now - days * DAY_MS).toISOString()
  const until = new Date(now).toISOString()
  const extracted = await extractWindow($, cfg, since, until)
  const { sessions } = extracted
  if (!sessions.length) return undefined
  const consent = consentLine(sessions.length, batchSessions(sessions).length, days, cfg.summaryModel, cfg.reportModel)
  return { since, until, extracted, consent }
}

// The preview only feeds the optional scan, so a failed extract still starts the interview, with nothing to read.
async function setupPreview($: EngineInterface, cfg: Config): Promise<{ preview: string; why: string }> {
  try {
    const window = await setupWindow($, cfg, cfg.setupDays)
    return { preview: window ? window.consent : noSessionsScan(cfg.setupDays), why: '' }
  } catch (err) {
    return { preview: SCAN_UNREADABLE, why: `; ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function startSetup($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  const { preview, why } = await setupPreview($, cfg)
  const text = fillTemplate(await readPrompt($, 'morning-setup.md'), {
    DATA_DIR: cfg.dataDir,
    PREVIEW: preview,
    PROFILE_HEADINGS: profileHeadingsBlock(),
    PROFILE: (await readProfile($, cfg)) ?? SETUP_NO_PROFILE,
  })
  submitPrompt($, 'morning-setup', text)
  return { text: `starting the setup interview; ${preview}${why}` }
}

async function runSetupScan($: EngineInterface, cfg: Config, days: number): Promise<{ text: string }> {
  if (scanRunning) return { text: 'a setup scan is already running' }
  scanRunning = true
  const status = (line: string | undefined) => {
    try {
      $.ui.status(line)
    } catch {
      // the status line is progress only; the scan goes on without it
    }
  }
  try {
    const runsDir = `${cfg.dataDir}/runs`
    const scanPath = `${runsDir}/setup-scan.md`
    for (const argv of [['mkdir', '-p', runsDir], ['test', '-w', runsDir]]) {
      const r = await $.process.run(argv)
      const reason = stderrHead(r.stderr)
      if (r.exitCode !== 0) return { text: `setup scan failed: cannot write to ${runsDir}${reason ? `: ${reason}` : ''}` }
    }
    const window = await setupWindow($, cfg, days)
    if (!window) return { text: noSessionsScan(days) }
    const { since, until, extracted, consent } = window
    status(`morning-report: ${consent}`)

    const usage: UsageByModel = {}
    const summarizer = fillTemplate(await readPrompt($, 'summarizer.md'), { PROFILE: SUMMARY_NO_PROFILE })
    const { failed, text } = await summarizeSessions($, cfg, summarizer, extracted.sessions, usage, (done, total) =>
      status(`morning-report: summarizing ${done}/${total}`),
    )
    const scan = await complete($, {
      model: cfg.reportModel,
      system: await readPrompt($, 'setup-scan.md'),
      prompt: scanPrompt({ since, until, days, extracted, failed, summaries: text }),
      maxTokens: REPORT_MAX_TOKENS,
      timeoutMs: REPORT_TIMEOUT_MS,
    }, usage)
    await $.fs.write(scanPath, scanFileText(scan, failed, extracted.sessions.length))
    return { text: `${scanPath}${notSummarized(failed)}` }
  } catch (err) {
    return { text: `setup scan failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    status(undefined)
    scanRunning = false
  }
}

async function launchctl($: EngineInterface, ...args: string[]): Promise<ProcessRunResult> {
  return $.process.run(['launchctl', ...args], { timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
}

async function mustRun($: EngineInterface, argv: string[]): Promise<void> {
  const r = await $.process.run(argv)
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${stderrHead(r.stderr)}`)
}

const twoDigits = (hour: number) => String(hour).padStart(2, '0')

const cannot = (verb: string, reason: string) => ({ text: `cannot ${verb}: ${reason}` })

async function runSchedule($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  const os = await readLine($, ['uname', '-s'])
  if (!os) return cannot('schedule', '`uname -s` failed or printed nothing')
  if (!isMacOS(os)) return { text: MANUAL_RUN_TEXT }
  if (!cfg.home) return cannot('schedule', 'HOME is not set')
  const claudePath = await readLine($, ['which', 'claude'])
  if (!claudePath) return cannot('schedule', 'no claude on PATH (which claude found nothing)')
  const uid = await readLine($, ['id', '-u'])
  if (!uid) return cannot('schedule', '`id -u` failed or printed nothing')
  const path = (await $.env.get('PATH')) ?? ''
  if (!path) return cannot('schedule', 'PATH is not set')
  // The job sees only its own environment and folder; a plugin it cannot see would make it remove itself.
  const check = jobPluginCheck({ claudePath, home: cfg.home, path, pluginName: $.plugin.name })
  const view = await $.process.run(check.argv, { cwd: check.cwd, timeoutMs: SHORT_PROCESS_TIMEOUT_MS })
  const state = view.exitCode === 0 ? view.stdout.trim() : ''
  if (state !== 'enabled') {
    const seen = state ? `lists ${$.plugin.name} as ${state}` : `failed: ${stderrHead(view.stderr)}`
    return cannot(
      'schedule',
      `the job clears every variable but HOME, PATH and the login ones (launchctl setenv included) and runs from ${cfg.home}, and there \`claude plugin list --json\` ${seen}. Install and enable the plugin for your user (not one project, not under CLAUDE_CONFIG_DIR), then schedule again`,
    )
  }
  const names = launchdNames(cfg.home, uid)
  await mustRun($, ['mkdir', '-p', names.logDir])
  await $.fs.write(names.plist, renderPlist({ claudePath, home: cfg.home, path, uid, hour: cfg.reportHour, pluginName: $.plugin.name }))
  // bootstrap refuses a service that is already loaded; not loaded is the common case.
  await launchctl($, 'bootout', names.target)
  const boot = await launchctl($, 'bootstrap', names.domain, names.plist)
  if (boot.exitCode !== 0) return { text: `launchctl bootstrap failed: ${stderrHead(boot.stderr)}` }
  return {
    text: `scheduled: ${names.label} runs claude -p /morning-run at ${twoDigits(cfg.reportHour)}:00 and hourly until ${twoDigits(cfg.reportHour + REPORT_FIRES - 1)}:00 (${names.plist}; log ${names.log}). /morning-setup remove undoes it.`,
  }
}

// The plist is deleted only once launchctl no longer has the job, so a failed bootout can be retried.
async function runRemove($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  if (!cfg.home) return cannot('remove', 'HOME is not set')
  // The plist and log paths do not depend on the uid, so a machine with nothing installed runs no process.
  // A log folder without a plist still goes through bootout: the job's self-removal deletes its plist
  // before its own bootout, so a failed bootout there leaves the job loaded with only its log folder.
  const { plist, logDir } = launchdNames(cfg.home, '')
  const hasPlist = await $.fs.exists(plist)
  if (!hasPlist && !(await $.fs.exists(logDir))) return { text: `nothing installed: no ${plist}` }
  const uid = await readLine($, ['id', '-u'])
  if (!uid) return cannot('remove', '`id -u` failed or printed nothing')
  const names = launchdNames(cfg.home, uid)
  const bootout = await launchctl($, 'bootout', names.target)
  if (bootout.exitCode !== 0 && (await launchctl($, 'print', names.target)).exitCode !== LAUNCHCTL_NO_SERVICE) {
    return { text: `launchctl bootout failed: ${stderrHead(bootout.stderr)}; nothing removed` }
  }
  if (hasPlist) await mustRun($, ['rm', '-f', names.plist])
  await mustRun($, ['rm', '-rf', names.logDir])
  if (!hasPlist && bootout.exitCode !== 0) {
    return { text: `nothing installed: no ${plist}; removed the leftover log folder ${logDir}` }
  }
  return {
    text: `removed the launchd job ${names.label}, ${names.plist} and ${names.logDir}. Your reports, answers, priorities and profile are still in ${cfg.dataDir}; delete that folder yourself if you want them gone.`,
  }
}

async function runSetup($: EngineInterface, cfg: Config, args: string): Promise<{ text: string }> {
  const parsed = parseSetupArgs(args)
  switch (parsed.kind) {
    case 'interview':
      return startSetup($, cfg)
    case 'schedule':
      return runSchedule($, cfg)
    case 'remove':
      return runRemove($, cfg)
    case 'usage':
      return { text: SETUP_USAGE }
  }
}

export const register: Register = (on, options) => {
  // Each registration is tried on its own: a name the account already uses is refused, and that
  // refusal must not take the remember line or the other commands down with it.
  on('session.start', async ($, e, next) => {
    const cfg = await resolveConfig($, options)
    const line = await freshRemember($, cfg)
    await update($, remember, () => line ?? null)
    const commands = [
      {
        name: 'morning-run',
        description: 'Write the morning report for the sessions since the last run',
        argumentHint: '[--force] [--backfill YYYY-MM-DD --until ISO]',
      },
      {
        name: 'morning-review',
        description: "Go through today's morning report: answer its questions, then start the fast track",
      },
      {
        name: 'morning-setup',
        description: 'Set up the morning report: a short interview that can read your recent sessions, then writes your profile',
        argumentHint: SETUP_ARGUMENT_HINT,
      },
    ]
    for (const command of commands) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.toast(`/${command.name} not registered: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    try {
      await $.tool.register({
        name: SCAN_TOOL,
        description:
          "Reads the person's Claude Code sessions over the last `days` days, summarizes them, writes a setup scan, and returns its file path. Takes a few minutes. Call it only after the person agreed to it in the /morning-setup interview, with the number of days they chose.",
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: 1, maximum: 7 } },
          required: ['days'],
          additionalProperties: false,
        },
      })
    } catch (err) {
      $.ui.toast(`${SCAN_TOOL} not registered: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      if ((await readProfile($, cfg)) === undefined) $.ui.toast('morning-report: run /morning-setup to start')
    } catch (err) {
      $.ui.toast(`morning-report: could not read ${cfg.dataDir}/profile.md: ${err instanceof Error ? err.message : String(err)}`)
    }
    return next(e)
  })

  // The scheduled job's entry point: hidden from the typeahead and /help, still runs when typed in full.
  on('command.describe', { command: 'morning-run' }, async ($, e, next) => ({ ...(await next(e)), isHidden: true }))

  on('command.run', { command: 'morning-run' }, async ($, e) => {
    const cfg = await resolveConfig($, options)
    let args: RunArgs
    try {
      args = parseRunArgs(e.args)
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
    const { text, status } = await runMorning($, cfg, args)
    if (status) await update($, remember, () => status.line ?? null)
    return { text }
  })

  on('command.run', { command: 'morning-review' }, async $ => {
    const cfg = await resolveConfig($, options)
    const now = Date.now()
    const today = localDate(now, new Date(now).getTimezoneOffset())
    const text = fillTemplate(await readPrompt($, 'morning-review.md'), {
      DATA_DIR: cfg.dataDir,
      TODAY: today,
      LAUNCH: launchInstruction(cfg.launchCommand),
    })
    submitPrompt($, 'morning-review', text)
    return { text: `opening ${cfg.dataDir}/${today}.md` }
  })

  on('command.run', { command: 'morning-setup' }, async ($, e) => {
    try {
      return await runSetup($, await resolveConfig($, options), e.args)
    } catch (err) {
      return { text: `morning-setup failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__morning-report__morning_setup_scan' }, async ($, e) => {
    try {
      return { result: (await runSetupScan($, await resolveConfig($, options), intOption(e.days, SETUP_DAYS))).text }
    } catch (err) {
      return { result: `setup scan failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = await read($, remember)
    if (line === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text wrap="wrap">
          <Text bold>Remember: </Text>
          {line}
        </Text>
      </Box>
    )
  })
}
