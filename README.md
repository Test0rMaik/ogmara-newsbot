# ogmara-newsbot

A self-hostable bot that publishes AI-composed posts to the
[Ogmara](https://ogmara.org) News Feed.

Point it at news sources, your own topics, or a folder of images. It composes
posts with the AI provider of your choice, adds hashtags, and publishes them to
a decentralized feed under a wallet you control.

> **Status: early development (v0.5.0).** The bot reads real RSS/Atom feeds,
> composes posts with the AI provider of your choice, and publishes them on a
> schedule without duplicates. See [Roadmap](#roadmap).

## Why a dry run by default

Ogmara news posts propagate across the whole node mesh and **cannot be truly
unpublished**. A misconfigured bot doesn't just embarrass you, it permanently
adds noise to a feed other people read.

So `dryRun: true` is the default. The bot composes and prints posts, and you
turn publishing on deliberately once you've read real output. `--dry-run` on the
command line can only ever make the bot *safer* — there is no flag that forces
live posting.

## Requirements

- Node.js 22 or newer
- An Ogmara L2 node to publish through (yours or a public one)
- A **dedicated** Klever wallet for the bot
- An API key for an AI provider (later phases)

## Quickstart

```bash
git clone https://github.com/Test0rMaik/ogmara-newsbot
cd ogmara-newsbot
npm install

cp config.example.yaml config.yaml   # edit: node URL, network
cp .env.example .env                 # add your bot wallet key
chmod 600 .env

npm run dev -- --dry-run
```

You should see your bot's wallet address, the node's health, and a rendered
post. Nothing is published.

## Wallet safety

**Use a wallet dedicated to this bot.** The key in `.env` *is* the identity
every post is attributed to — anyone holding it can post as your bot. Never use
a wallet that holds funds you care about.

`.env` is gitignored. Keep it that way, and `chmod 600` it.

You do **not** need to register the wallet on-chain to post news. Unregistered
wallets can publish; the node will make your bot solve a one-time proof-of-work
puzzle (a few seconds) before its first post is accepted.

Registering does two things: it raises the posting ceiling 6x (see
[below](#registering-the-wallet-6x-the-posting-limit)) and unlocks editing and
deleting your own posts. It costs ~4.4 KLV, once.

## Configuration

Two files, split so secrets never end up in the shareable one:

| File | Contains | Committed |
|---|---|---|
| `config.yaml` | node URL, cadence, tags, ratings | your choice — safe to share |
| `.env` | wallet key, AI API keys | **never** |

Every key is documented inline in [`config.example.yaml`](config.example.yaml).

### Sources and cadence

Each scheduled run posts **at most one item**. Your cadence is therefore set by
the cron expression, not by how much your feeds publish — a burst of twenty
articles doesn't become twenty posts.

```yaml
sources:
  rss:
    enabled: true
    schedule: "0 * * * *"    # hourly, on the hour
    maxAgeDays: 2            # skip anything older
    feeds:
      - url: https://feeds.bbci.co.uk/news/world/rss.xml
        publisher: BBC News
```

### Choosing an AI provider

```yaml
ai:
  provider: anthropic        # or openai | gemini | openai-compatible
  model: claude-opus-5
```

Four providers, one interface — switching is a config change. `openai-compatible`
points at any server speaking the OpenAI API (Ollama, LM Studio, vLLM,
OpenRouter), so the bot can run with **no cloud AI dependency at all**.

Only your chosen provider's API key is needed. Full setup, cost notes and
prompt customisation: **[docs/AI-PROVIDERS.md](docs/AI-PROVIDERS.md)**.

The prompt lives in [`prompts/news.md`](prompts/news.md) as editable Markdown —
that's where your bot gets its voice.

### When the model declines

Safety classifiers on current models cover cybersecurity and life-sciences
topics, and real world news brushes against both. When a model declines an
item, the bot logs it, marks it seen, and moves on:

```
Model declined to write about "..." (cyber) — skipping it.
```

Occasional on a general feed; not a bug.

### Duplicate handling

Two separate protections, because they catch different problems:

- **Already posted** — items are keyed by feed GUID or canonicalized URL, with
  tracking parameters (`utm_*`, `fbclid`, …) stripped, so the same article
  shared by newsletter and by social counts once.
- **Same story, different outlet** — a wire story syndicated to five publishers
  is five URLs. Headline similarity catches those so the bot doesn't post the
  same news five times.

The record lives in `data/ledger.json`. Keep it alongside your config — deleting
it makes the bot treat everything as new again.

### Giving the bot a name

```yaml
profile:
  displayName: My News Bot
  bio: Automated world-news posts. Not a human.
```

```bash
npm run dev -- --set-profile
```

Publishes to your node as a signed profile update. Works on an unregistered
wallet, and is last-write-wins, so re-running is harmless.

### Registering the wallet (6x the posting limit)

The node caps posts per wallet, and the cap depends on whether that wallet is
registered on-chain:

| | Unregistered | Registered |
|---|---|---|
| Per 10 minutes | 5 | **20** |
| Per 24 hours | 50 | **300** |

```bash
npm run dev -- --register
```

Costs **~4.4 KLV, once, non-refundable**, so the bot wallet must hold KLV
first. The command shows your balance and what you'd unlock, then asks for
confirmation — it never spends on its own, and it refuses outright when there's
no terminal to confirm at (use `--yes` for scripted runs).

The bot reports its registration status at every startup, so you always know
which tier you're on.

Two more things worth knowing about limits:

- They're enforced at the **ingress node only** — whichever node you post
  through sets your real ceiling. Run your own node and you set it yourself,
  via `[api.rate_limits]` in `ogmara.toml`.
- They aren't discoverable over the API, so the bot mirrors them in config
  (`posting.node*`). It refuses to start if your cadence would exceed 80% of
  the *unregistered* daily ceiling, since every wallet starts in that tier.

### Rate limits and the retry queue

When the node throttles the bot, the **already-composed** post is parked in
`data/queue.json` and published on a later run. It is never recomposed, so a
throttled post never costs a second AI call — and an article that scrolls out of
the feed while the bot waits still gets published.

Queued posts are published before anything new is composed. They expire after
24 hours by default, because stale news is worse than no news.

## Commands

```bash
npm run dev -- --once --dry-run   # one run, compose and print, never publish
npm run dev -- --once             # one run (for cron / systemd timers)
npm run dev                       # run on the configured schedule
npm run dev -- --config other.yaml
npm run dev -- --help

npm run dev -- --set-profile      # publish display name / bio from config
npm run dev -- --register         # register on-chain (SPENDS ~4.4 KLV, asks first)

npm test                          # unit tests
npm run lint                      # typecheck
npm run build                     # compile to dist/
```

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Config, wallet, node connection, publish pipeline, dry-run | **done** |
| P1 | RSS source, dedup ledger, scheduler | **done** |
| P2 | AI providers — Claude, OpenAI, Gemini, OpenAI-compatible | **done** |
| P3 | Topic source, image-directory source, media upload | planned |
| P4 | Rate-limit backoff, retries, structured logging | planned |
| P5 | Local web control panel (setup wizard, preview, approval) | planned |
| P6 | Docker, full docs, v1.0.0 | planned |

## Posting responsibly

This bot posts to a censorship-resistant feed under your name. Defaults are set
accordingly, and you should keep them:

- **Disclose that it's a bot.** A `#bot` tag is added by default.
- **Attribute your sources.** Summarize and link — don't republish other
  people's reporting wholesale.
- **Read your dry-run output** before going live.

## License

MIT — see [LICENSE](LICENSE).
