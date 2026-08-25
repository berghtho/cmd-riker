# Delivery workflow

How CMD Riker delivers work in any Target Project. Project-specific policy — reserved Owner
judgments, tracker conventions, declared operations — lives in the Target Project's own docs and
binds through the accepted mission, ADRs, and Standing Orders.

## Missions and Work Items

A mission may be a single request or a goal ("finish the Void biome"). For a goal, the Lead Agent
collects the open tracker issues serving it, confirms missing or ambiguous scope with the Owner,
and works the issues in series or in parallel as their dependencies allow. Each issue runs the
delivery loop below; the mission is complete when every collected issue is delivered or explicitly
returned to the Owner as blocked.

## Delivery loop

1. Read the issue, its plan when present, and every project authority it points to. A Work Item is
   ready only when its outcome, acceptance criteria, reserved Owner judgments, and permitted target
   paths are explicit.
2. Keep the Owner conversation available while delegating. Reserved Owner judgments return to the
   Owner with concrete options; they are not filled by a Worker Session.
3. Work each issue on one clean issue branch. The default branch is never an effectful checkout.
4. Give each effectful Worker Session one bounded assignment and one Execution Checkout as its sole
   write location. Parallel Worker Sessions get disjoint Execution Checkouts.
5. Verify with the Target Project's typed operations declared in `cmd-riker.operations.json`.
6. Request independent Review inside the Work Item only when a material risk is named. The Lead
   Agent adjudicates findings; a changed result gets fresh Verification.
7. Publish under the covering Standing Order: commit the verified result without altering its
   substance, push the issue branch, open the pull request, and merge it once required checks pass.
   Resolve merge conflicts by rebasing the issue branch and re-running Verification before merging.
8. Report per issue and at mission end: outcome, Verification evidence, Review findings or
   exceptions, and residual uncertainty.

## Publishing boundary

Push, pull-request, and merge effects run through the Lead Agent's direct `gh`/`git` reach, not
typed Forge operations; the merge gate is green Verification on the final branch state plus the
Standing Order's bounds. Never force-push the default branch and never rewrite published history; a
necessary change after merge is a new issue, not an amended one.

## Worker Session contract

- Work only inside the assigned Execution Checkout and declared targets. Preserve unrelated and
  owner-local files.
- Follow the issue, plan, project standards, and assignment. Ask through the Lead Agent when an
  Owner decision is missing.
- Leave implementation changes unstaged and uncommitted. CMD Riker inventories the Git-observable
  result against the recorded baseline and reconciles it before publishing.
- Return a concise structured outcome with changed paths, checks run, and remaining uncertainty.
