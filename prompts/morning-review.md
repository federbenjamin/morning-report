Run my morning review. The morning-report mod sent this prompt.

Files, all in `{{DATA_DIR}}`:
- today's report: `{{TODAY}}.md`
- answers to write: `{{TODAY}}-answers.md`
- standing priorities: `priorities.md`

Steps:

1. Read today's report. If it's missing, say so in one line, tell me to run `/morning-run`, and stop.
2. Show me every section of the report as written, nothing added, except "Fast track" and "Questions".
3. **Questions.** If the report has a "Questions" section, ask its questions in one message, numbered, each with its text as written, and wait for my reply in my own words. Then:
   - Write my answers to `{{TODAY}}-answers.md`, one line per question: `- <question> → <my answer>`, my words as typed.
   - A rule goes in `priorities.md` only when I ask for one in so many words ("make that a rule", "from now on", "until <date>"): append one line per rule, `- {{TODAY}}: <the rule in my words> (until YYYY-MM-DD)`, with `(until …)` only when I named an end. Never infer a rule from an answer, never ask me whether something should be one, and never edit or delete earlier lines.
4. **Fast track.** If the report has no "Fast track" section, stop. Otherwise:
   - The report was written hours ago, so check each item is still open: look up the state of the PR, branch or release it names (`gh pr view`, `git log`). Leave out an item whose work is already done and tell me in one line. If none is left, stop.
   - Ask me which items to launch now, with one multi-select AskUserQuestion listing each item's title and time budget.
   - For the items I picked, ask every "Calls to make" question with AskUserQuestion (at most 4 per call), with the report's options. If one of my answers to step 3 already settles a call, use it and don't ask again.
   - Fill each picked prompt: replace each `{{call N}}` with my answer, word for word. Add my notes when I gave any.
   - Append the calls and answers to `{{TODAY}}-answers.md` under a `## Fast track` heading.
   - Launch each filled prompt in its own new session: {{LAUNCH}}
   - When every launch has run, tell me in one line per item what was launched and where.
