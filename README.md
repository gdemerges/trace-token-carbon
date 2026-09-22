# TRACE — Token Rate And Carbon Estimator

What your AI tools actually consume: tokens per model, position within rate
limits, and carbon footprint. A menu-bar icon, a global shortcut for the
gauges, a dashboard for the detail.

macOS · Windows · Linux — Rust and Tauri, packaged at **4.4 MB**.

---

## Getting started

```bash
cargo run -p trace-app     # launch the app
cargo run -p trace-cli     # the same numbers, in the terminal
cargo test                 # core, CLI, and app tests
npm ci && npm test         # renderer tests (shared modules, catalogs)
npm run lint               # renderer lint, including unescaped-HTML checks
cargo tauri build          # package for the current system
```

Rust 1.89 or newer — the floor set by Tauri's own dependencies, and checked
in CI. On Linux, the system webview requires `libwebkit2gtk-4.1-dev`,
`libappindicator3-dev`, and `librsvg2-dev`; the keychain integration
requires `libdbus-1-dev` and `pkg-config`.

Continuous integration (`.github/workflows/rust.yml`) runs on all three
systems, with `clippy` and `rustfmt` as blocking errors. This isn't
precautionary boilerplate: file paths, POSIX permissions, config-directory
construction, and especially live-process detection differ across systems,
and CI has caught faults on Windows that no macOS machine could surface.
Three more jobs guard what the matrix doesn't: a build on the minimum Rust
version declared in `Cargo.toml`, `cargo audit` against the RustSec
advisory database, and the renderer's lint and tests.

The core can dump what it reads and computes, source by source, for
comparing two versions or inspecting a collector:

```bash
cargo run -p trace-core --example dump                # lists the dumps
cargo run -p trace-core --example dump -- collector   # events read from Claude Code
cargo run -p trace-core --example dump -- snapshot    # the JSON sent to the interface
```

The code layout is described under [Architecture](#architecture).

## Using it

| Action | Effect |
|---|---|
| `⌘⌥T` (`Ctrl+Alt+T`) | Opens the gauges over any application |
| Click the icon | Same |
| `Esc` | Closes the popover |
| `⌘Tab` | Reaches the dashboard when it's open |
| `⌘↩` | Opens the dashboard |
| `trace --json` | Machine output, for a status bar or a script |
| `trace --carbon` | Water, grid-mix sensitivity, uncertainty breakdown |
| `trace --lang=en` | Forces the language (`fr`, `en`) |

The shortcut, language, grid mix, refresh interval, menu-bar metric,
retained level of detail, and version check are all configured from the
dashboard's settings gear.

### Language

French and English. By default TRACE follows the system language; the
setting overrides it. The change applies without a restart — including
labels computed by the core (windows, sources, carbon equivalents) and the
formatting of numbers and dates.

The catalogs are two JSON files (`src/i18n/`), embedded in the binary and
passed to the interface over IPC: the renderer has no filesystem access, by
design. A test verifies that both languages carry exactly the same keys with
the same parameters, and that every key used in the code exists — a
misspelled key would otherwise render literally on screen with nothing else
to flag it.

**What stays in French:** the notes and citations in the carbon methodology
appendix (`carbon/factors.rs`, `carbon/sources.rs`). These are texts meant
for an auditable deliverable, still being pinned down; translating them
early would produce two versions to maintain, one of them unreviewed.

---

## What each source actually provides

TRACE aggregates five sources. They are not equivalent, and the app says so
instead of hiding it:

| Source | Tokens | Rate limits | How |
|---|:--:|:--:|---|
| **Claude Code** | ✅ | ~ | Local logs at `~/.claude/projects`. Cache broken down by TTL, so pricing is exact. |
| **Claude — live usage** | — | ✅ | Queries `/api/oauth/usage`, the endpoint Claude Code's own `/usage` command uses, with the OAuth credentials already present on the machine. **The only accurate source** for window occupancy. |
| **Codex CLI / Desktop** | ✅ | ✅ | Rollouts at `~/.codex/sessions`. The server already writes a per-window usage percentage there. |
| **Anthropic API** | ✅ | — | Organization usage and cost reports. **Billed** figures, across every machine. Requires an Admin key. |
| **OpenAI API** | ✅ | — | Organization usage report. Requires an Admin key. |

Gemini, Grok, and Ollama are not covered: none of the three write a usable
local token counter. Rather than keep a source that cannot produce a number,
it's left out. The underlying rule: never extrapolate from a character
count, which would produce a false value presented as a measurement.

---

## Methodology

### Carbon footprint

**EcoLogits / Boavizta** method, applied as-is:

1. GPU energy per generated token is linear in the number of **active**
   parameters — true for a dense model as much as for a mixture-of-experts.
2. The rest of the server is allocated pro rata to the GPUs mobilized, via
   latency.
3. The data center's PUE covers cooling and distribution losses. TRACE does
   not use a generic 1.2 PUE: each provider carries the range announced by
   the operators that host it (Anthropic on AWS and Google Cloud, OpenAI on
   Azure), and an unknown provider opens up to an ordinary colocation data
   center's range.
4. Hardware manufacturing is amortized over five years, pro rata to
   occupancy time.
5. The **water footprint** follows the same energy: on-site cooling
   (provider's WUE, applied to IT energy) plus the water consumed off-site to
   produce the electricity, which generally dominates the first term.

**A TRACE-specific extension, presented as such.** EcoLogits only counts
*output* tokens. That's untenable for agentic usage: this machine observes
1.30B cached-read tokens against 4.4M generated. Ignoring them would
underestimate the footprint by two orders of magnitude. Each token class is
therefore weighted by its energy cost relative to a decoded token, based on a
FLOPs accounting rather than intuition — a 37k-token prefill on a
100B-active-parameter model represents 7.4·10¹⁵ FLOPs, roughly 6.6 Wh on
eight A100s at 40% MFU, giving a ratio of about 0.017 relative to decoding.

**The result is a range, never a point value.** Providers don't publish
their model sizes: parameters are wide-bound estimates, which propagate to
the display. A single figure would suggest a measurement that doesn't exist.

Note: EcoLogits produces higher values than provider self-reports (≈2 Wh
versus ≈0.3 Wh for a short request). That's a known methodological
divergence, not a calculation error.

The grid mix is adjustable (France 56 g/kWh … world 480 g/kWh). The default
is the US average for closed models, since most inference capacity sits
there; the local mix applies to a model run on your own machine.

### Sensitivity analysis

A single total isn't defensible: it rests on a location assumption and on
unpublished model sizes. The total therefore ships with the means to
contest it, on screen as well as on the command line (`trace --carbon`) and
in the `--json` output:

- **the same total under four grid mixes** (France, EU, United States,
  world), with the ratio to the selected mix;
- **the uncertainty breakdown**, lever by lever. Each lever is replayed
  alone, the others held at their midpoint, and the high/low bound ratio
  obtained measures what it contributes on its own. In practice model size
  and grid mix dominate (×5 each), token weighting follows (×2.4), and PUE
  barely matters (×1.1) — the only assumption for which operators publish
  anything.

This is not statistical uncertainty propagation: the bounds are not
confidence intervals and the levers don't combine linearly. It's a
sensitivity analysis, and the interface says so.

### Factor traceability

Every constant in the calculation is tied to a source in
`crates/trace-core/src/carbon/sources.rs`, and `factor_table()` produces the
table that can be appended to a report: value, unit, citation, usage
caveat.

A `pinned` field distinguishes sources whose exact version and access date
have been recorded **against the publication itself** from those that
haven't been yet. An unpinned source remains usable inside the app — the
order of magnitude holds — but not in an audited deliverable, and its
citation says so explicitly rather than pretending otherwise. Making up a
version number to look tidy would be worse than an absent citation — it
would pass review.

Two tests enforce the discipline: one refuses any constant without a
source, the other freezes the list of what remains unpinned, so that pinning
one is a deliberate act and adding an unpinned one doesn't go unnoticed.

The table isn't confined to the code: the dashboard's **Methodology and
sources** card displays it in full, preceded by the count of unpinned
sources, and "Export" writes a second `…-methodology.csv` file next to the
data. A table of grams without the factors that produced it isn't
verifiable.

Grid mixes are all **location-based** factors (in the GHG Protocol sense).
They ignore the origin guarantees data-center operators purchase, which
would collapse the figure under a market-based approach. It's the
conservative choice, and the only one computable without provider
disclosure.

### Rate limits

Claude plan caps are published nowhere, vary by plan and model, and **actual
window occupancy is stored nowhere locally**: `/usage` obtains it by querying
the API. In decreasing order of reliability:

1. **The live reading.** TRACE queries the same endpoint Claude Code's
   `/usage` command uses, with the OAuth credentials already stored on the
   machine. The token never leaves the module that reads it: no log, no
   config file, no UI. It's Anthropic's own figure, and it takes priority
   over everything else.

   **Query discipline:**

   - one call every **15 minutes** at most, decoupled from the local
     refresh, which only re-reads files. A five-hour window doesn't move in a
     quarter hour, and TRACE shares this endpoint's quota with Claude Code
     itself;
   - **exponential backoff** on failure, capped at one hour: from 10 minutes
     after a rate-limit rejection (429), from 45 seconds after a transient
     network failure — punishing a micro-outage for ten minutes would leave
     a frozen figure for no reason. The `Retry-After` header takes
     precedence when the server provides one;
   - the last reading is **persisted**, one per window, replaced on each
     success. It survives a restart, and a restart doesn't trigger a call if
     the cached reading is recent;
   - past 45 minutes, the value stays displayed — it's the best information
     available — but the interface announces its age instead of presenting
     it as current. **A dated figure beats a false estimate**;
   - **the cadence is announced**: the gauge shows the reading's age *and*
     the next reading's due time ("live · 4 min ago · next in 11 min"). A
     figure frozen for a quarter hour would otherwise read as an outage,
     encouraging a reflex click on ⟳ at every check. Waiting out the cadence
     isn't an incident, so it isn't flagged as one — the red banner is
     reserved for actual failures;
   - the ⟳ button bypasses the cadence.
2. **Your manual reading.** If live data isn't available: type `/usage`,
   click "adjust" under the gauge, and enter the figure. TRACE cross-derives
   the per-product cap from it.
3. **Auto-calibration on a past window rejection.** Order of magnitude only:
   measured on a real case, the discrepancy reached a factor of 2.6. The
   value displays with an "≈" and a hollow-segment gauge, so it's never
   mistaken for a measurement.
4. **None of the above**: window consumption is shown without a percentage.
   A gauge with no scale beats a false one.

For Codex, a reading whose window has expired isn't shown as-is: the window
has since reset. TRACE uses it as a calibration point and recomputes the
current window's occupancy — so 0% if you haven't touched Codex since.

An important trap is handled here: `rateLimitType` is always `five_hour`,
even when the request was actually blocked by a **monthly spend cap**. On
this account, two rejections out of three were of that type. Conflating them
would calibrate the 5-hour gauge on an unrelated event — TRACE classifies the
real cause from the message and only uses genuine window rejections.

The scale's origin is always written under the gauge.

Consumption is **weighted** (output ×5, cache write ×1.25, cache read ×0.1):
a raw total would be swamped by cache and wouldn't track the real behavior
of the caps at all.

### Never double-counting

Three distinct traps, three safeguards. They share the property of
producing **inflated** numbers, the worst kind of error for a tool meant to
tell you when to ease off.

**1. The streaming duplicate.** Claude Code rewrites each message throughout
streaming: on this machine, **4,345 of 10,577 entries are duplicates**.
Without deduplication by `message.id`, the displayed bill would be inflated
by ~70%. Codex, for its part, exposes both a session cumulative and a
per-turn delta — summing the cumulative would multiply consumption by the
number of turns.

**2. Stacked daily aggregates.** Organization reports (Anthropic and OpenAI
Admin APIs) return an aggregate for the **current** day, which grows from
one reading to the next. Merged as an event stream, successive states would
add up instead of correcting each other: at a one-minute cadence, the
current day would end up counted over a thousand times. These sources are
therefore merged by **replacement** on the `(day, source, model, project)`
key — an empty reading, caused by a network outage, erases nothing.

**3. Local measurement versus billing.** `claude-code` reads this machine's
logs, `anthropic-api` reads the organization's billing: these are the
**same requests seen twice**. Summing them would double the total as soon as
an Admin key is configured, gauges included. The rule applied
(`crates/trace-core/src/provenance.rs`):

- local measurement takes precedence on the days it covers — it alone
  carries the project, session, and time;
- the billed figure only fills in days this machine saw nothing on: another
  machine, another workstation, a period before installation;
- the gap between the two isn't hidden either: it becomes the **"Measured
  here / billed"** card, the only *external* check TRACE has on its own
  numbers. A persistent gap says either that another machine is consuming
  on the same account, or that log reading is off. Both deserve to be seen
  rather than silently averaged away.

A daily aggregate also feeds **no gauge**: timestamped at midnight, it would
dump a full day's consumption — across every machine — into the five-hour
window that contains midnight.

---

## Dock presence (macOS)

TRACE is a background application: **no Dock icon at rest**, as befits a
menu-bar tool.

The icon appears while the dashboard is open, and disappears when it
closes. Without this, the window would become a trap: unreachable via
`⌘Tab`, and effectively lost if it slid behind another window. Clicking the
Dock icon reopens the dashboard, as in any macOS application.

A welcome side effect: while the icon is present, the application menu is
too, and standard editing shortcuts work in the settings' input fields.

## Alerts

TRACE warns via a system notification when a threshold is crossed (80% and
95% by default, adjustable). Three rules govern this behavior:

- **Never on an approximate scale.** Only gauges whose scale comes from the
  server or from your own calibration trigger an alert. An estimate derived
  from a 429 rejection has proven wrong by a factor of 2.6 — a false alert
  would destroy trust in every other one.
- **Once per threshold and per window.** Crossing a threshold is an event,
  not a state: repeating the notification every cycle would make the tool a
  nuisance. A jump from 0 to 96% produces a single notification, for the
  highest threshold crossed.
- **A new window rearms the thresholds.** A sliding window, which has no
  announced reset, rearms once an hour: a sustained saturation deserves more
  than one reminder, but not one per minute.

### Trajectory

The threshold says where you are; the trajectory says where you're headed.
At 40% and climbing fast there's still time to act, at 80% often less: it's
the slope, not the level, that indicates whether to ease off.

Every gauge therefore carries a projection — *"full in 26 min at this
rate"* — computed on the pace of the **last 45 minutes**, and shown in the
dashboard, the popover, the menu-bar tooltip, and the CLI. Three deliberate
refusals keep it defensible:

- **No reliable scale, no projection.** A measured cap is required, or one
  derived from a percentage the server communicated.
- **No recent activity, no projection.** A zero pace never saturates;
  announcing "in 340 h" would be noise.
- **Saturation past the reset doesn't count as saturation.** Hitting the cap
  at 3 a.m. is irrelevant if the window empties at 2 a.m.

A trajectory alert fires **at most once per window**, and only **before the
first threshold**: any later, it would duplicate the threshold alert instead
of anticipating it.

## Privacy

Everything is local. The logs analyzed contain your code and your
conversations: TRACE sends none of it anywhere.

The network requests, exhaustively:

| Destination | When | What's sent |
|---|---|---|
| `api.anthropic.com/api/oauth/usage` | every 15 min, if Claude Code is connected | the OAuth token already present on the machine |
| `api.anthropic.com` (organization reports) | every cycle, **if** an Admin key is configured | the Admin key |
| `api.openai.com` (organization report) | same | the Admin key |
| `api.github.com` | at startup then once a day, if `checkUpdates` is enabled | nothing beyond the IP address and installed version |

The last one is the only one added without being asked for, and it's a
one-click toggle in settings: nothing is downloaded or installed, it's a
notification and a link.

- The renderer has **no filesystem access**. It can only call the commands
  the app explicitly registers, under a Tauri capability file
  (`src-tauri/capabilities/default.json`) that grants window dragging and
  notifications and nothing else, and it runs under a **content security
  policy** (`src-tauri/tauri.conf.json`) that denies everything by default:
  local scripts only, no outbound connections, no remote resources.
- Project and model names come from parsed logs. They're escaped on display
  — the lint (`npm run lint`) rejects any HTML interpolation that doesn't go
  through the escaping function, unless the exception is annotated as
  audited — and the CSP is the second barrier.
- Links open in the browser only over HTTPS, and only to a closed list of
  hosts: the GitHub repository and the publishers of the sources the
  methodology cites.
- **API keys live in the system keychain** — Keychain on macOS, Credential
  Manager on Windows, Secret Service (GNOME Keyring, KWallet) on Linux — and
  never in `config.json`. If the keychain is unavailable, TRACE **refuses**
  to save the key rather than write it in plaintext, and says so in
  settings. A key left in plaintext by an earlier version moves to the
  keychain on first launch, and the file is rewritten without it. On macOS,
  the CLI is a separate binary: the first time it reads a key, the system
  asks whether to allow it.
- The index and preferences live in the platform's standard config
  directory. On macOS and Linux the folder is `0700`, and `config.json`
  and `index.db` are `0600`: the index carries the names of all your
  projects, your session identifiers, and your volumetrics. On Windows the
  folder sits in your profile (`%APPDATA%\TRACE`), whose default ACLs
  already restrict it to your account.
- Diagnostics go to a log file in the platform's log directory
  (`~/Library/Logs/com.gdemerges.trace` on macOS,
  `%LOCALAPPDATA%\com.gdemerges.trace\logs` on Windows,
  `~/.local/share/com.gdemerges.trace/logs` on Linux), capped at 1 MB with
  one rotated copy. It carries errors and warnings — never a key, a token, or
  log content.

---

## Architecture

Three crates, and the boundary between them is what holds the rest
together: `trace-core` knows NOTHING about Tauri or any UI, which is what
lets it be tested on all three systems without launching anything. The
renderer is the same DOM, the same hand-written SVG, the same stylesheet
across every platform target.

```
crates/trace-core/src/
  collectors/    one source = one module, isolated (a failing source blocks none of the others)
  carbon/        EcoLogits estimator, factors, citable-source registry
  models.rs      registry: pricing, context windows, estimated parameters
  ratelimits.rs  window reconstruction, calibration, saturation projection
  aggregate.rs   cost and carbon computed PER MODEL then summed, never on an average rate
  provenance.rs  who measures what, and who wins when two sources overlap
  present.rs     what the menu bar displays — pure logic, hence testable
  store.rs       preferences (JSON) and the index (SQLite)
  secrets.rs     Admin keys, in the system keychain
crates/trace-cli/  the `trace` binary
src-tauri/src/     menu-bar icon, popover, dashboard, generated PNG icons
src/renderer/      popover and dashboard — native HTML/CSS/JS, hand-written SVG
src/i18n/          two JSON catalogs, embedded in the binary
test/              renderer tests (`node --test`)
```

Indexing is incremental: each file is re-read from a byte offset, and
incomplete lines — Claude Code writes while it's being read — are picked up
on the next pass. Across 186 MB of logs: **230 ms cold**, and nothing
afterward as long as no file has grown.

### The index

The index is a SQLite database (`index.db`, SQLite embedded in the binary).
Each cycle writes only what changed — the few requests added, the records
folded by compaction — in a single transaction, where the earlier JSON index
was rewritten in full every time something moved. It runs in WAL mode, so
the CLI can read while the app writes. An `index.json` left by an earlier
version is read once, moved into the database on the next write, then
deleted.

### A single process writes the index

The app and the CLI share the same index, and both read it, complete it,
then write it back. Running `trace` while the app is running would
therefore make the two overwrite each other's collector offsets.

A database lock wouldn't be enough: the window to protect isn't the write —
a transaction, a few milliseconds — but the whole read → collect → write
cycle, which includes network calls no lock should be held across. The app
therefore declares itself **owner** of the index on each cycle; other
processes read and display correct numbers, but don't write. The claim
expires after five minutes, and an abrupt stop doesn't strand the file.

### Compaction

The index would otherwise keep one record per request over the full
retention window — three years. Beyond a few weeks, though, no view
consumes the individual request anymore: the daily series, the hourly
histogram, and the per-model and per-project breakdowns all go through
aggregation.

Past **90 days** (adjustable, 0 disables it), requests are folded into
**hourly** aggregates. Measured on a real index, folding to the hour divides
the volume by 46, folding to the day by 98 — the extra factor of two would
cost the hourly histogram, the view that shows work rhythms. What's lost,
knowingly: the session, which an hourly aggregate can span several of.
Session ranking therefore doesn't reach past the compaction boundary, which
is the only horizon where it means anything anyway.

A full log re-read — triggered by widening the retention — doesn't revive
folded detail: the compaction boundary travels with the index and discards
anything older at the door.

## How far back history goes

Available periods: 24h, 7d, 30d, 90d, 1 year, and **All** — which reaches as
far back as the sources allow. The date of the oldest indexed event is
displayed next to the selector: a long period that looks empty is then
explained by the source, not by data loss.

The limit doesn't come from TRACE, which keeps three years, but from the
tools:

- **Claude Code** purges its sessions after ~2 months. Nothing before that
  is recoverable — `stats-cache.json` retains older activity, but with no
  token counters at all.
- **Codex** keeps its rollouts much longer; its oldest files (`.json`
  format, pre-2026) contain no counters either.

Widening the retention setting automatically triggers a full re-read of the
sources: already-trimmed history wouldn't come back on its own, since
collectors resume reading from an offset.

## Cross-check: why the numbers differ from `stats-cache.json`

Claude Code keeps its own counter in `~/.claude/stats-cache.json`. It
reports **1.69× TRACE's total**, consistently day after day.

TRACE isn't undercounting: that cache sums streaming rewrites. Direct check
on the same logs — 2.33B tokens without deduplication, 1.38B with, a 1.69×
ratio that matches the observed gap exactly. A message rewritten three times
during its generation is billed once.

## Provider logos

Drop a file into `logo/` (PNG or WebP, transparent background) then run
`npm run logos`: it's recognized by its filename, resized, and embedded as
base64 in `src/renderer/shared/logos.js`. The packaging scripts do this
automatically.

Logos render as a **CSS mask**, not an image. They're monochrome
silhouettes, and the mask lets the color follow the theme: the OpenAI logo
is black in its file, which would be invisible on a dark background — as a
mask it becomes white, which is precisely its official usage. The Claude
logo keeps its brand terracotta, legible on both backgrounds.

A provider without a file falls back to a geometric glyph drawn in
`marks.js` — a neutral shape beats a trademark reproduced poorly.

## A note on colors

The interface holds to a strict code: **amber = tokens, teal = CO₂e, blue =
cost**. A color therefore always carries the same meaning, and a chart reads
without its legend.

Provider marks (to the left of model names and gauges) are identified by
**shape** instead, and tinted outside that trio — otherwise a teal logo on
the same line as a teal CO₂e value would become ambiguous.

## Distribution

`build/entitlements.mac.plist` carries the macOS entitlement set, and not
one more — every added entitlement widens what the app can do once
compromised.

Without **notarization**, the DMG is rejected by Gatekeeper on any machine
other than the one that built it. The workflow enables it; it only triggers
if signing happened, so a local build without a certificate remains
possible. Secrets expected by `.github/workflows/release-tauri.yml`,
triggered on a `v*` tag:

| Secret | Role |
|---|---|
| `MAC_CERTIFICATE_P12` / `MAC_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY` | "Developer ID Application" certificate |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | notarization |
| `WIN_CERTIFICATE_P12` / `WIN_CERTIFICATE_PASSWORD` | Authenticode signing |

If absent, the workflow produces unsigned binaries and says so, rather than
failing on a certificate a fork wouldn't have.

**No auto-update**, and there won't be one: installing code in the
background on someone's machine requires a trust chain that a serverless
menu-bar app can't seriously maintain. TRACE only reads the latest published
version and reports it once (`crates/trace-core/src/update.rs`).

---

## Known limitations

- Closed-model parameters are estimated: the carbon range spans roughly an
  order of magnitude. That's irreducible without provider disclosure.
- Pricing is pinned in `crates/trace-core/src/models.rs` and needs updating
  when it changes (overridable via `modelOverrides` in the config).
- Rate-limit weighting is an approximation: the real caps also weight by
  model, per an unpublished formula. Hence manual calibration, which
  sidesteps the problem by starting from a true value.
- Gemini CLI and Ollama provide no token history (see above).
- The local-measurement/billing split reasons at the **daily** level: using
  the same account from this machine *and* from another one on the same day
  means the other machine's share isn't reflected in the totals. The
  "Measured here / billed" card surfaces this but doesn't reconcile it — that
  would require a per-request timestamp organization reports don't provide.
- **Copilot Chat** stores its sessions in a SQLite database
  (`globalStorage/github.copilot-chat/session-store.db`). It hasn't been
  inspected: until it's confirmed to hold real token counters, no collector
  will be written for it. Same rule that keeps Gemini, Grok, and Ollama out
  — never a source incapable of producing a measured figure.

## License

MIT
