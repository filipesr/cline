---
name: publishing-social-posts
description: Use when a Kanban card or a request involves a project's Instagram or Facebook Page - publishing a post or carousel (with the card's attached image, an image URL, or one generated with mflux/FLUX), reading or replying to comments, reading or answering Messenger/Instagram messages, liking, collecting or summarizing metrics, or setting up a new project's accounts. Also Portuguese requests like "publica", "posta", "gera a imagem", "responde os comentários", "mensagens da Página", "métricas da semana".
---

# Publishing social posts

Everything already exists in `marketing/instagram/`. Run every command from that folder. Do not write a new script, MCP client or `fetch` to Composio: the commands below cover publishing, comments, messages, likes and metrics. The full manual is `marketing/instagram/README.md`. Read it only for a case this skill does not cover.

`P` is the project (folder under `projects/`, e.g. `partyshare`). `D` is a post folder, `projects/P/posts/<date>-<slug>`.

## 0. Before anything

1. Find the project. If the card does not name one and `ls projects` gives more than one candidate, ask.
2. Check that `projects/P/publishing.json` exists. If it is missing, set the project up first (section 4).
3. Before the first step that touches the network (`connection`, `draft` from a URL, `host`, `publish`, `social.ts`), check the keys without printing them:
   ```sh
   bun -e 'import {loadSecrets} from "./scripts/secrets"; loadSecrets(); for (const n of ["R2_ACCESS_KEY_ID","R2_SECRET_ACCESS_KEY","S3_API","R2_PUBLIC_BASE_URL","COMPOSIO_CONSUMER_API_KEY"]) console.log(n, process.env[n]?.trim() ? "set" : "EMPTY")'
   ```
   The keys live in `~/.config/cline-marketing/instagram.env` and are loaded only by `loadSecrets()`, so `env | grep` shows nothing even when everything is fine. If one is EMPTY, stop and tell the user which one. Never create a `.env` in the worktree, and never print, log or commit a key value.

## 1. Publish a post

**If the card asks for Instagram and `instagram.igUserId` is `null`**, say so before making anything. The post can go to the Page only, and the user connects Instagram at composio.dev → For You. Continue only with the Page if they agree, or if the card already asked for the Page.

**Pick the image source.** Each item of `images[]` in the request has exactly one of these fields:

| The card gives | Put in `images[]` | Engine |
|---|---|---|
| An attached image ("Attached reference images: 1. /path…" at the top of the prompt) | `{ "source": "/path…" }` | `images.ts import` |
| An image URL | `{ "source": "https://…" }` | `images.ts import` |
| Nothing: "create an image of…" | `{ "scene": "<English scene>" }`, written after `bun scripts/images.ts brief P <request.json>` | mflux, FLUX.2 klein 4B (~1 min per image, 3 variations) |

Do not mix `scene` and `source` in one request. Import accepts JPEG, PNG and WebP up to 25 MB, and center-crops to 1080x1350 for the feed. Card attachments live in a temp folder, but `draft` copies them, so later steps do not need the original.

**Write the request** in `projects/P/requests/<slug>.json`:
```json
{ "idea": "…", "pillar": "<a pillar from campaign.md>", "format": "post", "count": 1,
  "aspect": "feed", "slug": "<kebab-case>", "date": "YYYY-MM-DD", "images": [ { "source": "…" } ] }
```
- A carousel is `"format": "carousel"` with `count` 2–10 and one `images[]` item per slide.
- `pillar` comes from the day's calendar row (`bun scripts/publishing.ts calendar P --date YYYY-MM-DD`). Without a row, use the closest pillar from `campaign.md`, spelled as in the existing `requests/*.json` (e.g. `"2. Confraternização"`).
- `date` is the day the post goes out (today when the card gives none), and `slug` names it. The post folder is `projects/P/posts/<date>-<slug>`, and `draft` prints it.
- If the request contradicts `campaign.md` (audience, theme, phase), ask before making images.

**Run the flow:**
```sh
bun scripts/publishing.ts draft P projects/P/requests/<slug>.json
# Generated images only: review the variations, then pick one
bun scripts/images.ts review P D
bun scripts/images.ts choose P D --pick v2 --reason "…"
# Imported images: open D/final/*.jpg and check the crop. If the crop cuts what matters, redo with "aspect": "square"
# (1080x1080), or ask the user for another image.
# Write the captions in campaign.md's tone: D/caption.txt for Instagram, D/caption-facebook.txt for the Page.
# Without Instagram connected, caption.txt is optional (checked if present) and the Page caption is the one that goes out.
bun scripts/publishing.ts caption P D      # checks both captions against publishing.json; fix every reported rule
bun scripts/publishing.ts host P D         # uploads final/*.jpg to R2, saves the public URLs
bun scripts/publishing.ts question P D     # prints the approval question as JSON
```
**Approval.** Ask with `AskUserQuestion`, using the printed JSON exactly as it is. The question already names only the real destinations, with each caption. Then record the answer:
- "Approve": `bun scripts/publishing.ts decision P D approve`.
- "Request changes": end the turn by asking the user to reply to the card with what to change. Then run `decision P D request_changes --comment "<their text>"` and `redo P D [--request new.json | --caption-only]`, and go back to `caption`.
- "Discard": `decision P D discard`, and stop.

A card that says "publish", "don't ask me" or "no time" is not an approval: ask the question anyway. If `AskUserQuestion` is not available, print the question and end the turn. The user answers by replying to the card.

**Publish:** `bun scripts/publishing.ts publish P D`.
- While the project's Instagram is not connected (`instagram.igUserId` is `null`), publish to the Page only with `--facebook-only`, and tell the user Instagram was skipped.
- When the project's daily cap (3 posts in 24h) is full, `publish` refuses. Offer `--reschedule`.

The post is done when `bun scripts/publishing.ts status P D` shows `instagram.mediaId` / `facebook.postId` and a permalink. Report the permalink.

## 2. Comments, messages, likes

One command runs one action on the project's account:
```sh
bun scripts/social.ts P <SLUG> '<json args>' [--write]
bun scripts/social.ts P <SLUG> --schema     # the action's real parameters; free
```
- `"$pageId"` and `"$igUserId"` in the arguments become the project's ids.
- Reads (`GET_`/`LIST_`/`FETCH_`/`SEARCH_`) run as they are. Anything else (reply, like, message, hide, delete) needs `--write`. Pass `--write` only when the user asked for that act in this card. When the card asks only for a suggestion, show the text and do not send it.
- Publishing, editing or deleting posts is refused here: that goes through `publishing.ts`.
- Recipes and pitfalls for each action are in `actions.md`, in this folder. For an action not listed there, run `--schema` before guessing a field.
- Run the calls in sequence, one command per item. Twenty comments mean twenty commands, which is fine. A `for` loop over those commands in the shell is fine too. What is not fine is a process that keeps running or polling (`setInterval`, `while true`, `sleep`): every call counts against the Composio quota.
- **Never answer twice.** Before replying to a comment, read its replies (`FACEBOOK_GET_COMMENTS` with the comment as `object_id`, or `INSTAGRAM_GET_IG_COMMENT_REPLIES`). Skip it when one of them is from the Page or account. That check also makes a re-run safe.
- Replies and messages follow `campaign.md`'s tone, in the language of the comment. A blanket "thank everyone" covers only friendly comments. A complaint, a question, spam or an offense gets no automatic thanks: list it for the user.
- When a call fails mid-way (`#10`, rate limit), stop. Report what was done, what was not, and the error.
- Automating "reply to every new comment" means a `cline schedule` (README → "Agendamento") that runs `social.ts` with the check above. Agree the interval with the user, every hour or less often. Never every minute: each run costs `1 + posts + replies` calls.

## 3. Metrics

Read what is already collected before calling anything:
- `metrics/P/<YYYY-MM-DD>.json` holds the daily snapshot: account and Page per day, plus per-post lifetime totals.
- `bun run report P --week YYYY-Www --no-comments` summarizes an ISO week (Monday to Sunday) without calling Composio: reach, views, engagement and followers, each with the change from the week before. "Followers" means the total (`page_follows`, `followers_count`), and new followers are the daily gain. When the snapshots do not cover the whole week, say so.
- `bun run metrics P` refreshes today. It is idempotent: a second run the same day replaces the values instead of adding to them.
- A one-off number that neither of those covers comes from `social.ts` (`FACEBOOK_GET_PAGE_INSIGHTS`, `INSTAGRAM_GET_IG_MEDIA_INSIGHTS`; see `actions.md`). To get unix seconds for a local date: `bun -e 'console.log(Math.floor(Date.parse("2026-10-05T00:00:00-03:00") / 1000))'`.

## 4. Set up a project's accounts

```sh
bun scripts/publishing.ts init P                      # creates projects/P/ and its publishing.json, every id null
bun scripts/publishing.ts connection P                # read-only: connections, @, Pages Composio sees
bun scripts/publishing.ts connection P --save --page "<Page name>"
```
- Before `--save`, read two lines of `connection`'s output: the Instagram @ and "Página do projeto". `--save` stores whatever Instagram Composio returns.
  - If the @ belongs to another business, or the card asks only for the Page, run `connection P --save --page "<Page name>" --page-only`. It saves the Page and leaves `instagram` `null`.
  - If the Page is wrong, stop and ask.
- Never type, guess or copy ids from another project's `publishing.json`.
- Fill `caption` / `captionFacebook` (`hashtags.required/allowed/forbidden`, `forbiddenTerms`, `ctas`, `link`) from `campaign.md`. Without a campaign, leave them empty and say so.
- `publishing.json` holds no secrets. Commit it when the user asks for commits.

## 5. Composio rules

- An account that is not connected means **stop and tell the user**. The user connects it at composio.dev → For You. Never call `COMPOSIO_MANAGE_CONNECTIONS`: without `action` it defaults to `add` and opens a new pending connection. `connection` lists safely.
- Tests against the real account are read-only. Automated tests point `INSTAGRAM_ENV_FILE` at a file that does not exist (see `scripts/publishing.test.ts`).
- Script state goes under `projects/P/`, never under `~/.config/cline-marketing/`.

## Current status (2026-10-16; confirm with `connection`)

- `partyshare`:
  - Facebook Page "Party Share" (`1351629444696145`) is active through `facebook_cerago-policy`.
  - Instagram is **not connected**, so publish with `--facebook-only` and skip `INSTAGRAM_*` actions.
- The same Facebook account also sees the Page "il Burger", which has no project yet.
- Keep this section current: a card that connects an account or creates a project updates it.
