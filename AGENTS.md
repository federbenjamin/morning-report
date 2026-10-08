# morning-report

A Claude Code mod for accountability to your own goals: a daily status report written each night from your Claude Code sessions. `README.md` explains the parts.

## Project state

- 2026-10-06: public and installable; the maintainer is the only known user. Retires at the first report from another user.
- 2026-10-06: reads real data, each user's own transcripts, on their machine only. Reports stay local. Never commit a report, a transcript, or an extract. Does not retire: a fact of the product.

## Rules

- Mod code: `$` is only passed to functions in the same file as the hooks (`claude plugin validate` refuses `$` across an import). Pure logic goes in `hooks/pipeline.ts`, tested in `hooks/pipeline.test.ts`.
- Transcript parsing lives in `scripts/extract.py`, not the mod: `$.fs.read` caps a file at 4 MiB and a hook gets 10 s of its own CPU.

<!-- >>> git-workflow (generated block; do not edit by hand) -->
## Git workflow

- `main` changes only through a PR, squash-merged.
<!-- <<< git-workflow -->
