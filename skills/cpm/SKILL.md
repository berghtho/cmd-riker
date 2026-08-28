---
name: cpm
description: Commit, push, and merge the current branch into the main branch in one go. Use when the user invokes /cpm or asks to commit-push-merge.
---

# cpm — commit, push, merge

1. Run `git status` and `git diff` to see what changed. Nothing to commit and branch already merged: say so, stop.
2. Stage all changes and commit with a concise message in the repo's existing style (check `git log --oneline -5`).
3. Push the current branch (`git push -u origin <branch>` if no upstream).
4. If already on the main branch, stop after pushing.
5. Otherwise merge:
   - detect the main branch via `git symbolic-ref refs/remotes/origin/HEAD` (fallback `main`)
   - `git checkout <main>` && `git pull`
   - `git merge --no-ff <branch>` && `git push`
6. Report commit hash and merge result, concisely. On merge conflict: stop, list conflicting files, do not resolve on your own.
