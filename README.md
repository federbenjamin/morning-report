# morning-report

<p align="center"><strong>Accountability to your own goals: a daily status report written each night from your Claude Code sessions</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/federbenjamin/morning-report" alt="License"></a>
</p>

Accountability to your own goals: a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that reads your Claude Code sessions each night and writes a daily status report against the goals you set.

## Install

```
claude plugin install morning-report --marketplace federbenjamin/morning-report
```

Then run `/morning-setup` once in any Claude Code session. It is the one setup command, and it asks before it reads anything.

## Features

- **A report every morning.** Where yesterday's time went, each open stream and how long since it moved, and one first move toward your goal.
- **Goals you set in one interview.** `/morning-setup` asks what you are working toward and, if you agree, reads your recent sessions to see where your time goes.
- **A fast track.** Short sessions that close open threads, each with a prompt ready to launch.
- **A review that remembers.** `/morning-review` asks the report's questions and saves your answers, so tomorrow's report knows more.
- **Runs on a schedule.** On macOS, `/morning-setup schedule` installs a nightly job; `/morning-setup remove` takes it out.
- **Stays on your machine.** It reads only this machine's sessions, and the reports stay in your data folder.

## Usage

### Set up

`/morning-setup` builds your `profile.md`, the file that tells each report what you are working toward.

1. **The cost.** `/morning-setup` counts your sessions from the last `setupDays` days (7 at most) and starts an interview in the same session. It shows what reading them would cost: the number of sessions, the summary calls on `summaryModel`, and one `reportModel` call. It asks whether to read them, and for how many days, or to skip. Nothing is read yet. When the sessions cannot be counted (no `python3`, or the extract fails), the command says why and the interview starts without the scan.
2. **Round one:** what you are working on, and what you want a morning report to do for you.
3. **The scan**, only if you agreed. It reads those sessions' transcripts, summarizes them, and writes `runs/setup-scan.md`: where your time went by project, and the streams and habits it saw. It takes a few minutes.
4. **Round two:** your week as the scan saw it: which work matters most, which is background, and what the report should notice or count from day to day. When you skipped the scan, or there was nothing to read, there is no round two.
5. **`profile.md`** is written to your data folder under five headings: Working on, What the report is for, Counts as progress, Watch for, Track. A heading you leave blank asks the report for nothing.

Run `/morning-setup` again whenever your goal changes. It shows your current profile first, and you can skip the scan.

**`/morning-setup schedule`** (macOS) installs a launchd job, `com.morning-report`. It runs `claude -p /morning-run` at `reportHour`, then hourly for four more hours so a Mac that was asleep catches up; once the day's report exists, the later runs skip. The job's log is `~/Library/Logs/com.morning-report/run.log`. The job clears every environment variable but `HOME`, `PATH` and the login ones (`USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `SSH_AUTH_SOCK`), including any set with `launchctl setenv`, and runs from your home folder, so `schedule` first checks that `claude plugin list` lists the plugin enabled there; a plugin installed for one project, or under `CLAUDE_CONFIG_DIR`, is refused. After you uninstall the plugin, the job removes itself the next time it fires, and writes why to its log first. While the plugin is disabled, the job runs nothing. When `claude plugin list` fails, the job stays installed and writes the failure to its log. On other systems, run `claude -p /morning-run` each morning by hand, or put it in your own scheduler.

### Each morning

The report is about two screens, not counting the fast track. Every report has:

- **Yesterday:** where the time went, from your active hours.
- **Things on the go:** each open stream, where it stands, and how long since it moved; what finished goes under "Wrapped up".
- **First move today:** one small action toward what counts as progress, with a time budget.
- **Fast track:** 2–3 short sessions that close open threads. Each lists the calls only you can make, and a prompt ready to launch.
- **Questions:** five, each with options, so tomorrow's report knows more.
- **One thing to remember all day:** shown in every session's status area for 36 hours.

Your profile adds the rest. When **Watch for** names something, the report adds "What you're doing well" and "What's not working", each with a session and a time for every example, and "Drift" for patterns across days. When **Track** names a limit or a regular output, the report keeps count of it. After two weeks of reports, an "Is this working?" section checks your progress against your goal.

Run **`/morning-review`** in any session to go through the report: it asks its questions and saves your answers, then asks which fast-track items to start. With `launchCommand` set, it starts each one in a new session; with it empty (the default), it prints each filled prompt for you to paste.

### Remove

```
/morning-setup remove
```

This unloads the launchd job and deletes its plist (`~/Library/LaunchAgents/com.morning-report.plist`) and its log folder. Your reports, answers, priorities and profile stay in your data folder; the command prints its path. Delete that folder yourself if you want them gone. Then uninstall the plugin:

```
claude plugin uninstall morning-report@morning-report
```

## Configuration

Set them with `/plugin configure morning-report@morning-report`, or under `pluginConfigs["morning-report@morning-report"].options` in `~/.claude/settings.json`:

| Option | Default |
| --- | --- |
| `dataDir` | `~/.morning-report` |
| `summaryModel` | `sonnet` |
| `reportModel` | `opus` |
| `sessionLogsDir` | empty (skip): an optional folder of `<session-id>.md` logs to read beside the transcripts |
| `notifyCommand` | empty (skip): a command run with one message argument when a report is ready or fails |
| `gitCommit` | `false`. When on and `dataDir` is a folder of a git repo, each run commits that folder and pushes. A failed push is reported, never fatal. Ignore `state.json` and `remember.txt` in that repo. |
| `launchCommand` | empty: `/morning-review` prints the filled prompts to paste. Otherwise a command with `{dir}`, `{name}` and `{prompt}` slots, e.g. one that opens a terminal tab running `claude` |
| `setupDays` | `7` (at most 7): how many days of sessions `/morning-setup` offers to read |
| `reportHour` | `5` (0–19): the hour `/morning-setup schedule` runs the report, then hourly for four hours. Run `/morning-setup schedule` again after you change it. |

### Files in `dataDir`

| File | Written by |
| --- | --- |
| `profile.md` | `/morning-setup`: an interview that can read your recent sessions, under five fixed headings |
| `<date>.md` | the nightly run |
| `<date>-answers.md` | `/morning-review` |
| `priorities.md` | `/morning-review`, one line per ruling, `(until YYYY-MM-DD)` when it expires |
| `remember.txt` | the nightly run |
| `runs/<date>-summaries.md`, `runs/<date>-run.json` | the nightly run (the summaries the report read; window, counts, seconds, token usage per model) |
| `state.json` | the nightly run (watermark, the report window's start, report date) |
| `runs/setup-scan.md` | `/morning-setup`, when you let it read your sessions (time by project, the streams and habits it saw; the interview reads it) |

## How it works

1. **At `reportHour`:** launchd (macOS) runs `claude -p /morning-run`, and again on the hour for four hours. Once today's report exists, the later runs skip.
2. **Extract:** `scripts/extract.py` pulls the window's sessions as prose: what you typed, the agent's text, and each subagent's task and final report. It keeps prompts you typed while a turn ran. It drops tool output, headless sessions, and everything from a typed `/morning-review` or `/morning-setup` on.
3. **Summarize:** one call to `summaryModel` per batch of sessions, a long session alone and short ones together (`prompts/summarizer.md` with your `profile.md` inserted).
4. **Report:** one call to `reportModel` (`prompts/report.md` with your `profile.md` inserted). It reads the summaries, the last 14 reports with your answers, and the unexpired lines of `priorities.md`.
5. **Output:** the plugin writes `<date>.md` and `remember.txt`, saves the summaries and the token usage under `runs/`, advances the watermark, and runs `notifyCommand`.
6. **`/morning-review`** in any session does four things:
   - shows the key parts of today's report;
   - asks its questions and saves your answers and priority rulings;
   - asks which fast-track items to launch and the calls each one needs;
   - fills each picked item's prompt with your answers, then starts it in a new session through `launchCommand`, or prints it for you to paste when `launchCommand` is empty.

The window runs from the last successful run to now, capped at 72h.

Failures:
- **Transient** (a rate limit, overload, a server error, a dropped connection): the call retries after 30, 60, 120 and 240 s. The waits run as a `sleep` child process, because a `$.clock.sleep` would count against the hook's 10 s budget.
- **Permanent** (auth, billing, a bad model id): the run stops.
- **Still failing:** a session whose summary fails after its retries is listed as not summarized. The run fails only when more than half fail.
- **Failed run:** keeps the watermark, so the next run covers the gap.

To fill in past days, `/morning-run --backfill YYYY-MM-DD --until <ISO time>` writes that date's report over the 24h before `--until`. It leaves the watermark, the remember line and notifications alone. Backfill oldest first, so each report reads the ones before it.

Your active time is computed from your message times, with overlapping sessions counted once, and given to the report as a fact. A second run on the same day is skipped unless you pass `/morning-run --force`, which redoes the report over the first run's window.

### Cost

Each night's run makes:

- one `summaryModel` call per batch of sessions: a long session gets a call of its own, and short ones share one;
- one `reportModel` call for the report.

An example day of 34 sessions took 26 summary calls and 1 report call. The setup scan has the same shape, once, over up to 7 days; `/morning-setup` prints its count before you run it. The interview runs in your own Claude Code session.

### Limits

- **Scheduled runs are macOS only.** On other systems, run `claude -p /morning-run` by hand or from your own scheduler.
- **launchd and the keychain.** The scheduled job runs `claude` headless. On a Mac where you have never run `claude` from a terminal in this login, it may not find your credentials; run `claude` once interactively first. The job's log shows the failure.
- **This machine only.** The report reads the sessions on this machine, and the reports stay in your data folder unless you turn on `gitCommit`.

## Contributing

Report a problem or ask a question in [Issues](https://github.com/federbenjamin/morning-report/issues). Pull requests are welcome; see [CONTRIBUTING.md](https://github.com/federbenjamin/.github/blob/main/CONTRIBUTING.md), and report a security issue as [SECURITY.md](https://github.com/federbenjamin/.github/blob/main/SECURITY.md) says.

Run the plugin from a checkout:

```
claude --plugin-dir .
```

Checks, from the repo root:

```
python3 -m unittest discover -s scripts -p 'test_*.py'
claude plugin test .
tsc -p .
claude plugin validate .
```

`tsc -p .` reads the engine's types from `.claude-plugin/types/`, which Claude Code writes the first time it loads the plugin from this folder (any `claude --plugin-dir .` run).

### Checked on Claude Code 2.1.291 (2026-10-06)

- `claude -p "/morning-run"` runs the mod's command and waits for its model calls before exiting.
- `$.fs.write` and `$.process.run` need no permission prompt in a headless run.
- `$.ui.status` draws as its own line, `⚠ morning-report: <text>`, above a command-based status line.

## License

MIT © Benjamin Feder. See [LICENSE](LICENSE).
