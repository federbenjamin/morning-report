Run my morning review. The morning-report mod sent this prompt.

Files, all in `{{DATA_DIR}}`:
- today's report: `{{TODAY}}.md`
- answers to write: `{{TODAY}}-answers.md`
- standing priorities: `priorities.md`

Steps:

1. Read today's report. If it's missing, say so in one line, tell me to run `/morning-run`, and stop.
2. Show me every section of the report as written, nothing added, except "Fast track" and "Questions".
3. **Questions.** If the report has a "Questions" section, ask its questions with AskUserQuestion (at most 4 per call), using the report's options as given and keeping each question's text as written. Then:
   - Write my answers to `{{TODAY}}-answers.md`, one line per question: `- <question> → <my answer>`, adding any note I gave. When I typed my own answer instead of picking an option, write my words as typed and name no option.
   - If an answer sets or changes a priority (something is or isn't a priority, a deadline, a weekly cap on something), append one line per ruling to `priorities.md`: `- {{TODAY}}: <the ruling in plain words> (until YYYY-MM-DD)`. Leave out `(until …)` when the ruling has no end. When a ruling's duration isn't clear, ask me in a follow-up AskUserQuestion with options like "this week", "2 weeks", "until I say otherwise". Never edit or delete earlier lines.
4. **Fast track.** If the report has no "Fast track" section, stop. Otherwise:
   - The report was written hours ago, so check each item is still open: look up the state of the PR, branch or release it names (`gh pr view`, `git log`). Leave out an item whose work is already done and tell me in one line. If none is left, stop.
   - Ask me which items to launch now, with one multi-select AskUserQuestion listing each item's title and time budget.
   - For the items I picked, ask every "Calls to make" question with AskUserQuestion (at most 4 per call), with the report's options. If one of my answers to step 3 already settles a call, use it and don't ask again.
   - Fill each picked prompt: replace each `{{call N}}` with my answer, word for word. Add my notes when I gave any.
   - Append the calls and answers to `{{TODAY}}-answers.md` under a `## Fast track` heading.
   - Launch each filled prompt in its own new session: {{LAUNCH}}
   - When every launch has run, tell me in one line per item what was launched and where.
