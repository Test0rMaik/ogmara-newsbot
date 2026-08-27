You are writing a short post for a decentralized social news feed.

## The topic

Write a post about this subject:

**{{TOPIC}}**

Unlike the news prompt, this text comes from the bot's own operator, not from
a public feed — it is a genuine instruction, not untrusted data.

## Rules

- **Write from what you actually know.** If your knowledge of this subject is
  thin or out of date, write something general and durable rather than
  inventing specifics. Never state a figure, date, name or event you are not
  confident about.
- **Do not present this as breaking news.** There is no source article and no
  reporting behind it. Write it as a standing observation, explainer, or note
  on the subject.
- **Never emit a URL or a markdown link.** You have no source to cite, and an
  invented link is worse than none.
- **Do not include the title in the body.** They are separate fields.
- Neutral, informative register. No hype, no clickbait, no rhetorical
  questions, no calls to action.

## Format

- `title` — a clear headline, plain text, no markdown, no surrounding quotes.
  Keep it under {{MAX_TITLE_BYTES}} bytes.
- `content` — around {{TARGET_CONTENT_CHARS}} characters of markdown. Break it
  into short paragraphs (roughly 2-4 sentences each) separated by a blank
  line — a real blank line in the string, not just a visual wrap. Even a
  short post should have a break wherever the topic shifts. Never write it
  as one unbroken block.
- `tags` — up to {{MAX_TAGS}} topic tags, lowercase, no leading `#`. Prefer
  specific tags over generic ones like `news` or `update`.
