The morning-report mod sent this prompt for the person at this keyboard. Interview them in two rounds, then write their morning-report profile.

The report is written each night from the day's Claude Code sessions and read first thing in the morning. It always covers yesterday, what is on the go, one first move for today, a few next steps ready to launch, and one or two open questions. The profile decides the rest: what the report leads with, what counts as progress, what it notices across days, and what it keeps count of. A heading written as `(none)` asks the report for nothing. Ask only what the report needs to do this for this person.

# Their profile now

{{PROFILE}}

# How to run the interview

- When the profile above is not `(none yet)`, show it to them first. Each round then confirms or changes what it already says, heading by heading; never start blank.
- A heading they leave blank, or have nothing for, is written as `(none)`.
- Before writing, when `{{DATA_DIR}}/profile.md` exists, copy it to `{{DATA_DIR}}/profile-<today, YYYY-MM-DD>-old.md`.
- Write each heading line as `## ` and the heading alone; the words after the dash below say what goes under it. Under each, write a sentence or a short list in their words.

First: may the mod read their sessions?
The mod can read their recent Claude Code sessions, so round two can show
where their time went. This is what it would read: {{PREVIEW}}
When that reads `(no sessions…`, there is nothing to read: say so in one
line and go to round one.
Otherwise show them that line. Ask with AskUserQuestion whether to read
their sessions, and for how many days, from 1 to 7, or to skip it. Fewer
days cost fewer calls. Nothing is read yet: the reading happens after round
one.

Round one: what they are doing and what they want the report for.
Find out what they are working on or toward right now, in their own words.
Find out what they want a morning report to do for them. Ask one open
question at a time, with AskUserQuestion when options help and free text
when they do not.
Done when you can say in one sentence what this person wants to read first
each morning.

Then the scan, only if they said yes, and never before round one is done.
Call the `morning_setup_scan` tool with the number of days they chose. Tell
them it takes a few minutes. When it returns a file path, that file is the
scan for round two. A note may follow the path, such as how many sessions
were not summarized; the path is still the scan, so pass the note on in
one line and go on.

There is no round two when they skipped, when there was nothing to read,
or when the tool returned anything but a file path. In that last case, tell
them in one line what it returned. Then do not ask round two's questions;
go straight to writing the profile below from round one's answers.

Round two: their week, as the scan saw it. Read the scan file now, not
before. Show where the time went, by project. Find out which of it matters
most to them and which is background. Find out what they want the report to
notice, count, or follow from day to day.
Done when you know what the report leads with, what it follows across days,
and what it leaves out.

Then write {{DATA_DIR}}/profile.md under exactly these headings, in their
words:

{{PROFILE_HEADINGS}}

Show it to them once. Then tell them: run `/morning-setup schedule` to have the report ready each morning (macOS; elsewhere, run `claude -p /morning-run` by hand). Then stop.
