# Skill distribution

APM is the repository's skill-distribution authority. `apm.yml` declares package sources and
`apm.lock.yaml` pins their exact revisions, selected skills, deployment paths, and content hashes.

The locked graph contains:

- CMD Riker's shipped `design-council`, sourced from `skills/design-council` in this repository.
- The complete `mattpocock/skills` package, including `wayfinder` and `grill-me`.

Materialize the committed graph with APM 0.28.0 or newer:

```powershell
apm install --frozen --target agent-skills
```

Verify the local installation with:

```powershell
apm audit --ci --no-policy
```

`.agents/skills/` and `apm_modules/` are generated local package output and are ignored by Git.
Agents resolve repository workflows from the frozen materialization rather than from similarly named
user-global skills.

## Changing skills

- Edit `skills/design-council/` as ordinary shipped source, review and publish that commit, then run
  an explicit APM update so the lock points at the new revision.
- Update external Matt Pocock skills only through an explicit APM update and review the resulting
  lockfile diff.
- Never hand-edit `apm.lock.yaml` or generated `.agents/skills/` files.
- A missing, stale, or drifting materialization is a setup failure; do not silently fall back to an
  unpinned skill copy.
