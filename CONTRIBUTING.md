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
