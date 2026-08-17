# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI from this
clone so the remote selects `berghtho/cmd-riker`.

## Conventions

- Create multi-line issue bodies with `gh issue create --body-file <path>`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List issues with `gh issue list --state <open|closed|all> --json number,title,url,state,labels,assignees`.
- Comment with `gh issue comment <number> --body-file <path>`.
- Change labels or assignees with `gh issue edit`.
- Close only after posting the durable resolution comment.
- In human-facing text, refer to an issue by its linked title rather than a bare number.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

The canonical map is one issue labelled `wayfinder:map`. Every ticket is a native child issue with
exactly one `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.

- Create all issues first, then wire relationships in a second pass.
- Add a child with GraphQL `addSubIssue`, using the map and child node IDs returned by
  `gh issue view <number> --json id`.
- Add a dependency with GraphQL `addBlockedBy`; `issueId` is the blocked ticket and
  `blockingIssueId` is its prerequisite.
- The frontier is the map's open children with no open `blockedBy` node and no assignee, in map order.
- Claim before work with `gh issue edit <number> --add-assignee @me`.
- Resolve by posting the answer as a comment, closing the ticket, and appending a one-line linked gist
  to the map's `Decisions so far` section.
- Keep open tickets out of the map body. Native child and dependency relationships are their index.
