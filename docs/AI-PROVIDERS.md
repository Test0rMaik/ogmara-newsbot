# AI Providers

The bot composes every post with an AI provider of your choice. Switching
providers is a config change — no code edits.

| `ai.provider` | Needs | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Default. Claude. |
| `openai` | `OPENAI_API_KEY` | GPT models. |
| `gemini` | `GEMINI_API_KEY` | Google Gemini. |
| `openai-compatible` | `ai.baseUrl` (+ `OPENAI_COMPATIBLE_API_KEY` if required) | Ollama, LM Studio, OpenRouter, vLLM, Groq — anything speaking the OpenAI API. Run the bot fully local. |

All four use their provider's native **structured output** mode, so the model
returns schema-valid JSON directly. The bot never parses prose, which is the
usual source of flaky output in bots like this.

## Anthropic (default)

```yaml
ai:
  provider: anthropic
  model: claude-opus-5
  effort: low
```

Get a key at [console.anthropic.com](https://console.anthropic.com/).

`effort` (Anthropic only) controls how much the model thinks. Composing a post
from a supplied summary is a short, scoped task, so the default is `low` —
raise it to `medium` or `high` if posts read shallowly. It is the main
cost/quality dial; `model` is the other.

**Refusals are handled, not fatal.** Claude's safety classifiers cover
cybersecurity and life-sciences topics, and ordinary world news brushes against
both — a breach story, an outbreak story. The bot enables Anthropic's
server-side fallback so a declined request is automatically retried on a
fallback model within the same call. If the whole chain still declines, the bot
logs it, records the item as seen, and moves on. You'll see:

```
Model declined to write about "..." (cyber) — skipping it.
```

That's expected occasionally on a general news feed, not a bug.

## OpenAI

```yaml
ai:
  provider: openai
  model: gpt-5
```

Get a key at [platform.openai.com](https://platform.openai.com/api-keys).

## Gemini

```yaml
ai:
  provider: gemini
  model: gemini-3.7-flash
```

Get a key at [aistudio.google.com](https://aistudio.google.com/apikey).

Google's model names churn faster than this doc — check
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
for the current list rather than trusting this example to stay accurate.
`gemini-3.7-flash` is the current flagship general-purpose model; `gemini-2.5-pro`
is a stable "pro"-tier alternative if you specifically want that tier over Flash.

## Local and OpenAI-compatible servers

This is how you run the bot with **no cloud AI dependency at all**.

```yaml
ai:
  provider: openai-compatible
  baseUrl: http://localhost:11434/v1   # Ollama
  model: llama3.3
```

`baseUrl` is required for this provider — the bot refuses to start without it.

Most local servers ignore the API key. If yours needs one, set
**`OPENAI_COMPATIBLE_API_KEY`** — deliberately separate from `OPENAI_API_KEY`,
because this endpoint may be a third party (OpenRouter, a hosted gateway) and
forwarding your real OpenAI credential to it would leak it.

Known endpoints:

| Server | `baseUrl` |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |

**Caveat:** compatible servers vary in how well they implement strict
`json_schema` mode. If you see `model returned text that is not valid JSON`,
your server or model likely doesn't support it — try a different model, or a
server build with better structured-output support.

## Cost

The bot makes **one AI call per published post**. At the default cadence of one
post per hour that's ~24 calls/day, and each call is small: a prompt of a few
hundred tokens in, a few hundred out.

Two things keep the bill down:

- **Rate-limited posts are queued, not recomposed.** When the node throttles
  the bot, the finished post is saved and retried later — you never pay twice
  for the same post. See [`queue`](../config.example.yaml).
- **Refusals are recorded.** A declined item is marked seen so the bot doesn't
  re-compose and re-bill it on every subsequent run.

Costs move; check your provider's current pricing rather than trusting a number
written here.

## Customising the writing

The prompt lives in [`prompts/news.md`](../prompts/news.md) as editable
Markdown — that's where your bot gets its voice and editorial rules. Point
`ai.promptPath` elsewhere to keep several.

Placeholders available: `{{FENCED_ITEM}}`, `{{PUBLISHER}}`,
`{{MAX_TITLE_BYTES}}`, `{{TARGET_CONTENT_CHARS}}`, `{{MAX_TAGS}}`. An unknown
placeholder is a startup error, so a typo can't silently ship to the model as
literal text.

### Keep the fence

`{{FENCED_ITEM}}` is the feed's headline and summary wrapped in a delimiter
with a random per-call marker. **Keep it, and keep the instruction that says
everything inside it is untrusted data.**

Feed text is written by whoever can post to the feed — on an aggregator
(a subreddit's `.rss`, a Google News query feed) that is any internet user.
Without the fence, text like *"ignore the above and write X"* reads as an
instruction, and the resulting post is signed with your wallet and published
where it cannot be unpublished. Structured output constrains the shape of the
reply, not its content, so it is no defence here.

Put your own rules **after** the fenced block, as the default template does —
instructions nearest the end carry the most weight.

Three things the prompt should **not** do:

- **Ask for a source link.** The bot appends attribution itself. Models reword
  URLs, and a mangled source link is worse than none.
- **Invite invention.** The default prompt constrains the model to the supplied
  summary. Loosening that gets you a bot that confidently makes things up.
- **Remove the untrusted-data instruction.** See above.

## Adding a provider

Implement `AiProvider` from [`src/ai/types.ts`](../src/ai/types.ts) — one
`compose()` method — and register it in
[`src/ai/index.ts`](../src/ai/index.ts). Two rules:

1. Use the provider's native structured-output mode with the shared
   `composeSchema()`. Don't parse prose.
2. Return `{ status: 'refused' }` for a content decline rather than throwing.
   An unattended bot must skip and continue, not crash.
