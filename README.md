# ogmara-newsbot

A self-hostable bot that publishes AI-composed posts to the
[Ogmara](https://ogmara.org) News Feed.

Point it at news sources, your own topics, or a folder of images. It composes
posts with the AI provider of your choice, adds hashtags, and publishes them to
a decentralized feed under a wallet you control.

> **Status: early development (v0.1.0).** The publishing pipeline works
> end-to-end in dry-run mode. Sources and AI composition are not implemented
> yet — see [Roadmap](#roadmap).

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
puzzle (a few seconds) before its first post is accepted. On-chain registration
unlocks editing and deleting your own posts.

## Configuration

Two files, split so secrets never end up in the shareable one:

| File | Contains | Committed |
|---|---|---|
| `config.yaml` | node URL, cadence, tags, ratings | your choice — safe to share |
| `.env` | wallet key, AI API keys | **never** |

Every key is documented inline in [`config.example.yaml`](config.example.yaml).

### Rate limits — the one setting people get wrong

Ogmara nodes cap news posts **per wallet, per hour**, and the reference node
currently allows **5**. This is *not* discoverable over the API, so you tell the
bot what your node allows via `posting.nodeNewsLimitPerHour`.

Two things worth knowing:

- Limits are enforced at the **ingress node only** — whichever node you post
  through sets your real ceiling. Running your own node means you set it.
- The bot refuses to start if `maxPostsPerHour` exceeds 80% of the node limit,
  so there is always headroom for retries.

## Commands

```bash
npm run dev -- --dry-run          # compose and print, never publish
npm run dev -- --config other.yaml
npm run dev -- --help

npm test                          # unit tests
npm run lint                      # typecheck
npm run build                     # compile to dist/
```

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Config, wallet, node connection, publish pipeline, dry-run | **done** |
| P1 | RSS source, dedup ledger, scheduler | planned |
| P2 | AI providers — Claude, OpenAI, Gemini, OpenAI-compatible | planned |
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
