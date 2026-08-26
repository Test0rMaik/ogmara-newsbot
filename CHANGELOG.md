# Changelog

All notable changes to ogmara-newsbot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
