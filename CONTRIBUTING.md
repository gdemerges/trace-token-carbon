# Contributing

## Languages

TRACE is written by a French speaker and read by an international audience.
Each kind of text has one language, so nobody has to guess:

| What | Language |
|---|---|
| Code comments and doc comments (`//`, `///`, `//!`, JSDoc) | French |
| Test names (`fn une_cle_n_est_jamais_ecrite…`, `test('esc neutralise…')`) | French |
| Commit messages — imperative, one line that says *why* | French |
| `README.md`, `CONTRIBUTING.md` | English |
| Interface strings | Both — `src/i18n/fr.json` and `src/i18n/en.json`, never in code |

Identifiers stay in English, as the language of the ecosystem around them.

An interface string written directly in the code is a bug: it won't be
translated and no test will catch it. Add the key to **both** catalogs; the
tests check that the two carry the same keys, the same parameters, and that
every key used in the code exists.

The notes and citations in the carbon methodology (`carbon/factors.rs`,
`carbon/sources.rs`) stay in French for now — see the README.

## Before a commit

```bash
cargo fmt --all
cargo clippy --workspace --all-targets   # no warning survives: CI denies them
cargo test
npm run lint
npm test
```

## Troubleshooting a local build

**`error[E0463]: can't find crate for tauri`** (or a plugin, or
`tauri_macros`) although the dependency is declared: the `target/` cache holds
artifacts that cargo thinks are fresh but rustc can't load — typically after a
toolchain update. Purge the affected crates and rebuild:

```bash
cargo clean -p tauri -p tauri-macros -p tauri-codegen \
  -p tauri-plugin-global-shortcut -p tauri-plugin-notification \
  -p tauri-plugin-opener -p tauri-plugin-log
cargo build -p trace-app
```

A full `cargo clean` also works, but recompiles everything.

**`os error 4551` (Windows)** — "an application control policy blocked this
file": Smart App Control refuses a freshly compiled, unsigned executable (test
binary, build script, `trace.exe`). It isn't a test failure. Delete the blocked
file — or its `target/debug/build/<crate>-<hash>/` directory for a build
script — and run the command again; it usually passes on the next build.
Doctests, compiled to temporary executables, can't be retried this way: run
them in CI.

**The UI test fixture.** `test/fixtures/snapshot.json` is a real snapshot,
anonymized (project names replaced). Regenerate it when the JSON shape
changes: `cargo run -p trace-core --example dump -- snapshot`, then rename the
projects.

## Rules the code relies on

- **No HTML interpolation without `esc()`.** Project and model names come
  from parsed logs. The lint enforces it; an exception needs an
  `eslint-disable-next-line` comment that says what was audited.
- **No key on disk.** Admin keys go through `trace_core::secrets`, which
  writes to the system keychain and refuses to fall back to plaintext.
- **Tests never touch the real keychain**: call
  `trace_core::secrets::use_memory_backend()` in any test that loads a
  configuration.
- **A figure that can't be measured isn't shown.** No extrapolation from a
  character count, no percentage without a known scale. See the README for
  the reasoning behind each source.
