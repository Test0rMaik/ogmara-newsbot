# Changelog

All notable changes to ogmara-newsbot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-26

P1 — the bot now reads real feeds and posts on a schedule, without duplicates.
Post prose is still assembled from the feed's own summary; AI composition is P2.

### Added

- **RSS 2.0 / Atom 1.0 source** (`src/sources/rss.ts`). Both formats map onto a
  common `Candidate`. One unreachable or malformed feed is reported as a warning
  rather than failing the poll, so a single dead publisher cannot stop an
  unattended bot. Atom `rel="alternate"` links are preferred over `rel="self"` —
  picking `self` would make every post link back to the feed instead of the
  article. HTML is stripped from summaries, since the text is passed on to an AI
  provider and may be quoted.
- **Deduplication** (`src/dedup.ts`), covering two distinct failure modes:
  - *Same item seen twice* — every poll re-reads the whole feed, so without a
    stable key the bot would repost its backlog on every run. Keys prefer the
    feed's GUID, falling back to a canonicalized URL.
  - *Same story from different publishers* — a wire story syndicated to five
    outlets is five URLs, and posting all five is the most obvious way a news
    bot reads as spam. Jaccard similarity over normalized headline tokens
    catches it; set overlap handles the light reordering syndication produces,
    which character-level distance does not.
  - URL canonicalization strips `utm_*` and friends, so the same article shared
    by newsletter and by social does not post twice.
- **Ledger** (`src/ledger.ts`) — durable record of what has been posted, written
  atomically (temp file + rename) so a crash mid-write leaves the previous good
  file rather than a truncated one. A corrupt ledger is a hard startup error,
  never a silent reset: starting empty would repost everything.
- **Scheduler** (`src/scheduler.ts`) — cron via `croner`. Overlapping runs are
  skipped rather than queued, so a slow feed poll cannot stack concurrent runs
  racing on the ledger. Invalid cron expressions are rejected at config
  validation, not at the first tick.
- **Pipeline** (`src/pipeline.ts`) — poll → filter → compose → publish → record.
  One item per run by design: cadence stays a scheduling decision the operator
  controls, rather than an emergent property of how much a feed published.
  Feed-derived posts always carry an attribution link.
- **Bounded HTTP** (`src/http.ts`) — every fetch capped on size, time and
  scheme. The body is read incrementally and aborted on overrun rather than
  buffered then checked, so an oversized response cannot exhaust memory first.
  `Content-Length` is used as an early reject but never trusted alone.
- `--once` flag for single runs under cron or systemd timers.
- Config sections for `sources.rss` and `storage`.

### Fixed

- `truncateTitle` overshot the protocol's 256-byte title cap by 2 bytes: it
  reserved one byte for the ellipsis, but `…` is three bytes in UTF-8. It also
  sliced by UTF-16 unit, which could sever a surrogate pair and emit invalid
  UTF-8 for a headline containing emoji. Now reserves the real width and
  iterates code points. Both caught by tests before any release.

### Notes

- Dry runs are deliberately **not** recorded in the ledger, so they stay
  repeatable — recording them would silently swallow the operator's first real
  post once they went live. Covered by a test.
- 87 tests. Verified against live BBC and Guardian feeds.
- Chose `fast-xml-parser` + `croner` (10 packages total, 0 advisories) over
  `rss-parser` (last published 2023) and `feedparser` (9 deps including four
  separate `lodash.*` packages). `fast-xml-parser`'s six dependencies were
  checked and are all published by the same maintainer under the project's own
  org — legitimate modularization in 5.9.0, not a supply-chain compromise.
- Storage is a JSON file rather than SQLite: at this bot's volume it is
  adequate, needs no native build toolchain for people installing the bot, and
  stays readable and editable by the operator.

## [0.1.0] - 2026-08-26

Initial scaffold — P0. The publish pipeline works end-to-end in dry-run mode;
sources and AI composition are not implemented yet.

### Added

- **Configuration** (`src/config.ts`) — YAML config validated with Zod, secrets
  read separately from the environment so a shared `config.yaml` can never leak
  a wallet key. Validation is strict and runs once at startup: a bot posting to
  an un-retractable public feed should refuse to start on a questionable config
  rather than discover the problem after publishing.
  - Refuses to start when `posting.maxPostsPerHour` exceeds 80% of
    `posting.nodeNewsLimitPerHour`, leaving headroom for retries.
  - Validates the wallet key's shape up front, so a typo surfaces as a clear
    config error instead of an opaque signing failure later.
- **Tag handling** (`src/hashtags.ts`) — extraction and normalization to the
  protocol rules: lowercase, `[a-z0-9-]`, ≤64 bytes each, ≤10 tags. Nodes index
  whatever is in the `tags` array and never parse post content, so a tag dropped
  here does not exist as far as the network is concerned — there is no
  server-side safety net, hence one module with direct test coverage (21 tests).
  - Diacritics are folded (`München` → `munchen`) rather than replaced, which
    would yield `m-nchen` and fragment the tag index for non-English feeds.
  - Required tags outrank AI suggestions, so a model returning ten enthusiastic
    tags cannot push the bot-disclosure tag off a post.
- **Publisher** (`src/ogmara.ts`) — wraps `@ogmara/sdk` with a token-bucket
  posting budget, protocol-cap validation before signing, and rate-limit 429
  handling. Node-side rate limits are returned as a result rather than thrown,
  since they are expected and the caller should re-queue rather than fail.
- **CLI** (`src/index.ts`) — `--dry-run`, `--config`, `--help`. Reports wallet
  address, node health and mode before rendering a post.
- Dry-run posting mode, on by default. `--dry-run` can only make the bot safer;
  live posting requires editing the config file deliberately.
- MIT LICENSE, README, `config.example.yaml`, `.env.example`, CI workflow.

### Notes

- Depends on `@ogmara/sdk` ^0.49.0 from npm.
- The SDK already auto-solves the node's one-time proof-of-work challenge, so
  the bot only surfaces progress rather than implementing the solver.
