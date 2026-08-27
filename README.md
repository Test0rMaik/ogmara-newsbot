# ogmara-newsbot

A self-hostable bot that publishes AI-composed posts to the
[Ogmara](https://ogmara.org) News Feed.

Point it at news feeds, your own topics, or a folder of images. It composes
posts with the AI provider of your choice, adds hashtags, and publishes them to
a decentralized feed under a wallet you control.

> **Status: v0.9.0.** Three sources — news feeds, your own topics, and local
> image folders — composed by the AI provider of your choice and published on
> a schedule without duplicates. Ships with a web control panel, Docker
> packaging, and a first-run `--init` flow. See [Roadmap](#roadmap).

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
- A **dedicated** Klever wallet for the bot — `--init` can generate one for you
  (see [Quickstart](#quickstart)), or bring your own
- An API key for an AI provider (or a local server, e.g. Ollama — see [Choosing an AI provider](#choosing-an-ai-provider))

## Quickstart

```bash
git clone https://github.com/Test0rMaik/ogmara-newsbot
cd ogmara-newsbot
npm install

npm run dev -- --init
```

`--init` creates `config.yaml` from the example, and — since it's running at a
real terminal — offers to generate a wallet key for you (or set `OGMARA_WALLET_KEY`
in `.env` yourself if you'd rather supply your own). It never overwrites either
file if you already have them, so it's always safe to run again as a status
check. Then edit `config.yaml` (node URL, network, enable at least one
source), add an AI provider key to `.env`, and:

```bash
npm run dev -- --dry-run
```

You should see your bot's wallet address, the node's health, and a rendered
post. Nothing is published.

### Or with Docker

```bash
git clone https://github.com/Test0rMaik/ogmara-newsbot
cd ogmara-newsbot
npm install
npm run dev -- --init          # generates config.yaml + .env on the host

# edit config.yaml, add an AI key to .env, then:
docker compose up --build
```

`--init` needs to run on the host first (once) — Docker's bind mount expects
`config.yaml` and `.env` to already exist before the container starts.
Afterward, same files, same `data/` ledger — just containerized.
`config.yaml` is mounted read-only and `data/` is bind-mounted from the host
(not a Docker-managed named volume — deliberately, so the ledger, queue and
wallet-backup-reminder state `--init` just created on the host are the exact
same files the container sees, not a separate store), so neither disappears
on a rebuild. If you enable the control panel
(`panel.enabled: true`), see the networking note in `docker-compose.yml`
first: its `bind: 127.0.0.1` default is unreachable through Docker's port
publishing, for a reason worth understanding before you widen it.

## Wallet safety

**Use a wallet dedicated to this bot.** The key in `.env` *is* the identity
every post is attributed to — anyone holding it can post as your bot. Never use
a wallet that holds funds you care about.

`.env` is gitignored. Keep it that way, and `chmod 600` it (`--init` does this
for you automatically).

If you let `--init` generate a wallet, **back it up before doing anything
else** — copy `.env` somewhere safe. This key is the only copy of that
identity; if it's lost, it's gone, and if it's ever funded, so is the KLV.
Generation is never silent or automatic on an unattended run (cron, systemd,
a restarting container) specifically to avoid minting a key nobody notices —
it only happens when you explicitly ask (`--init`) or confirm at a real
terminal prompt. Once generated, the control panel (`panel.enabled: true`)
shows a reminder banner on every visit until you confirm you've backed it up,
since a one-time terminal message is easy to miss entirely.

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

### Your own topics

No feeds, no fetching — the bot writes about subjects you define:

```yaml
sources:
  topics:
    enabled: true
    schedule: "0 */6 * * *"
    topics:
      - The Klever blockchain ecosystem
      - Decentralized social networks and censorship resistance
    minIntervalHours: 168      # don't repeat a topic within a week
```

This is the only source with no external input, which makes it the safest one:
nothing an attacker controls reaches the prompt.

Topics rotate rather than cycling in order, so a short list doesn't read as
repetitive. The re-post gap is enforced through the dedup ledger, so it
survives restarts.

The prompt tells the model to write from durable knowledge rather than
inventing specifics — there's no source article behind a topic post, so
anything specific it states is unverifiable.

### Local image folders

```yaml
sources:
  imagedir:
    enabled: true
    schedule: "0 12 * * *"
    directories:
      - /home/you/pictures/bot
    maxBytes: 8388608
    contentRating: general
```

A random unposted image is picked, captioned by a vision model, uploaded to
IPFS through your node, and attached to the post.

Things worth knowing:

- **Images are identified by content, not filename.** Renaming a file or
  copying it into another watched folder won't republish it.
- **Directories are not scanned recursively.** Deliberate — pointing this at a
  folder shouldn't be able to sweep up everything beneath it.
- **Both prerequisites are checked at startup**: the model must accept images,
  and your node must have media uploads available. The bot refuses to start
  otherwise, rather than captioning a picture the model never saw.
- **In dry run the image is validated but not uploaded.** Pinning bytes to
  IPFS for a post that's never published would be a real side effect, so the
  render says `(validated, not uploaded — dry run)`.
- Set `contentRating` deliberately. Mislabelling is a reportable offence under
  the moderation spec.

Running a local model? Set `ai.compatibleSupportsVision: true` only if it
genuinely accepts images.

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

### Control panel

A small browser UI for changing the display name and registering the wallet,
served alongside the bot's normal schedule (not `--once`):

```yaml
panel:
  enabled: true
```

The bot **always** signs with its own wallet (`OGMARA_WALLET_KEY`) — the panel
never holds or asks for anyone else's key. `panel.adminWallets` instead names
the *separate* wallets allowed to log in and drive the bot's wallet, exactly
like the l2-node dashboard's `admin_wallets`: you prove ownership by signing a
one-time challenge with your Klever Extension or K5, never by handing over a
key.

```yaml
panel:
  enabled: true
  adminWallets:
    - klv1youroperatorwallet...
```

From `http://127.0.0.1:8787` (the default), **no login is required at all** —
matching the node dashboard's localhost bypass, and enough for
`ssh -L 8787:localhost:8787` tunnelling with zero extra config. Only widen
`panel.bind` beyond loopback once `adminWallets` is set, and only put a
reverse proxy in front of it once you've read `panel.trustedProxies` and
`panel.allowedHosts` in `config.example.yaml` — both exist to stop a
misconfigured proxy from silently handing out that same bypass to everyone.

### Rate limits and the retry queue

When the node throttles the bot, the **already-composed** post is parked in
`data/queue.json` and published on a later run. It is never recomposed, so a
throttled post never costs a second AI call — and an article that scrolls out of
the feed while the bot waits still gets published.

Queued posts are published before anything new is composed. They expire after
24 hours by default, because stale news is worse than no news.

## Commands

```bash
npm run dev -- --init             # scaffold config.yaml / generate a wallet key, then exit
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
| P3 | Topic source, image-directory source, media upload | **done** |
| P4 | Rate-limit backoff, retries | **done** (in the 0.4.0 audit pass) |
| P5 | Web control panel (display name, wallet registration, wallet-signature login) | **done** |
| P6 | Docker (**done**), full docs, v1.0.0 | in progress |

## Posting responsibly

This bot posts to a censorship-resistant feed under your name. Defaults are set
accordingly, and you should keep them:

- **Disclose that it's a bot.** A `#bot` tag is added by default.
- **Attribute your sources.** Summarize and link — don't republish other
  people's reporting wholesale.
- **Read your dry-run output** before going live.

## License

MIT — see [LICENSE](LICENSE).
