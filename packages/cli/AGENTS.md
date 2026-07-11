# CLI UX requirements

Every change under this directory must follow Vercel's `cli-ux` skill: <https://github.com/vercel/vercel/tree/main/packages/cli/.agents/skills/cli-ux>.

Before editing, define the user job, current friction, desired outcome, success signal, and non-goals. Inspect the command, its coupled output paths, and tests. Audit TTY/human, non-TTY, JSON/JSONL, stdout/stderr, invalid input, timeout, and interrupt behavior as applicable.

Required contracts:

- Keep machine stdout JSON/JSONL-only, ANSI-free, stable, and bounded.
- Machine failures expose stable `status`, `reason`, `message`, and `userActionRequired`; include safe `next.command` plus `next.argv` when useful.
- Never echo raw malformed input, secrets, upstream objects, or untrusted text in suggested commands.
- Reject unknown flags, extra arguments, ambiguous input, and unknown `--fields` with an exact recovery step.
- Keep help/schema output complete: required fields, enums, defaults, limits, mutually exclusive options, stdin behavior, and runnable examples.
- Put diagnostics, warnings, and progress on stderr; keep pipeable results on stdout.
- Use `!` for warnings and `✓` only for a completed phase. Do not use decorative emoji.
- Errors state what failed and how to fix it. Avoid vague or apologetic copy.
- Preserve command names, flags, exit codes, JSON fields, and stdout contracts unless the migration is explicit and tested.

Before finishing, run `pnpm lint`, focused CLI tests, `pnpm --filter @genie-react/cli typecheck`, and the relevant built CLI transcripts. Review the full checklist in the linked skill's `references/verification.md`.
