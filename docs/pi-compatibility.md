# Pi compatibility

CMD Riker pins Pi's agent core, model runtime, coding agent, terminal primitives, and server package
to `0.85.0`. Its Owner interface uses the coding agent's public `main` export with inline extensions.
Pi owns terminal rendering and input; Riker retains its conversation, authority, scheduling, and
recovery state.

## Packaging requirement

The published coding-agent `0.85.0` SDK imports `@earendil-works/pi-server` through its experimental
modules, but does not declare that dependency. Without it, importing the SDK or starting Riker fails
with `ERR_MODULE_NOT_FOUND`, even though TypeScript and the build pass. Riker pins `pi-server`
directly to resolve that import. This does not configure or start Pi's experimental server.
Recheck whether the direct dependency is needed at the next Pi upgrade.

Pi 0.85.0 also bundles esbuild binaries for other platforms. The verified Windows review bundle
grew from 294 MiB (installed `local.52`, Pi 0.84.3) to 593 MiB, with about 294 MiB in esbuild files.
The release builder preserves these dependencies, increasing disk use and copying time.

`tests/pi-package-compatibility.test.ts` starts the public CLI entrypoint in a separate process with
an isolated Pi directory. Keep this runtime check alongside typechecking; declaration files cannot
prove that the published JavaScript dependency graph loads.

## Useful changes from 0.84.3

Sources: upstream [0.85.0 release](https://github.com/earendil-works/pi/releases/tag/v0.85.0) and
[0.84.4 changelog](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md#0844---2026-08-28).

| Change | Effect in Riker |
| --- | --- |
| Clickable **Jump to latest message** in a scrolled fullscreen transcript | Available in Pi's Owner terminal. `End` returns to the bottom and follows new output. |
| Faster fullscreen transcript search | Applies to Pi's rendered conversation. On Windows, `Ctrl+F` opens search. |
| `fullscreenCopyOnSelect: false` | Optional Pi setting. Keeps selection highlighted; `Ctrl+X` copies it explicitly. The upgrade leaves the existing preference alone. |
| Terminal capability overrides | Optional remedy for terminals misdetecting links, images, or truecolor. Existing detection stays enabled. |
| Codex SSE terminal-event parsing and provider stream fixes | Used by Pi's model runtime. Real provider authentication and network behavior still need live verification. |
| Windows shell abort fallback when `taskkill.exe` is absent from PATH | Relevant to the Lead's native shell tools. |

The new editor-border working indicator belongs to Pi's own model loop. Riker intercepts Owner input
and runs its Lead separately, so it continues to show work through its own status display.
Restorable `SessionManager.inMemory()` entries and RPC `clear_queue` do not replace Riker's durable
conversation or turn scheduler. Claude thinking improvements do not add Claude as a Lead Model:
Riker currently exposes local OpenAI-compatible models and OpenAI Codex for that role. Worker
harnesses keep their own provider integrations.

## Upgrade proof

Run the package-entrypoint, Pi adapter, Owner interface, CLI, gateway, turn-scheduler, and metrics
tests, then typecheck and build. Use isolated state for any terminal smoke test. A source dependency
upgrade does not update an installed Riker release; activation still goes through `riker upgrade`.
