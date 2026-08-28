---
name: cpr
description: Commit, push, and open a GitHub pull request for the current branch. Use when the user invokes /cpr or asks to commit-push-PR.
---

# cpr — commit, push, pull request

1. Run `git status` and `git diff` to see what changed. Nothing to commit and a PR already exists (`gh pr view`): say so, link it, stop.
2. If on the main branch, create a descriptive branch first (`git checkout -b <type>/<short-slug>`).
3. Stage all changes and commit with a concise message in the repo's existing style (check `git log --oneline -5`).
4. Push the branch (`git push -u origin <branch>`).
5. Open the PR with `gh pr create` against the main branch. Title from the commit; body: short summary of what and why, bullet list of changes.
6. Report the PR URL, concisely.
