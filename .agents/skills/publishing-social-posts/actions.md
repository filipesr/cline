# Composio actions for `social.ts`

Every call is `bun scripts/social.ts P <SLUG> '<json>' [--write]`, run from `marketing/instagram/`. The parameters below come from `--schema` (2026-10-16). A `*` marks a required parameter. "W" means the action needs `--write`.

## Facebook Page

| Task | Slug | Arguments |
|---|---|---|
| Latest posts | `FACEBOOK_GET_PAGE_POSTS` | `{"page_id":"$pageId","limit":10,"fields":"id,from,message,created_time,permalink_url"}` (also `since`, `until`). It reads the Page's feed, visitors' posts included: "the Page's last post" is the first one whose `from.id` is `$pageId` |
| Comments of a post | `FACEBOOK_GET_COMMENTS` | `{"object_id":"<postId>","filter":"stream","fields":"id,message,created_time,from,like_count,comment_count,is_hidden"}` (also `order`, `limit`) |
| One comment | `FACEBOOK_GET_COMMENT` | `{"comment_id":"<commentId>","fields":"id,message,from,like_count,reactions.summary(total_count){name,type}"}` |
| Reply to a comment, or comment on a post (W) | `FACEBOOK_CREATE_COMMENT` | `{"object_id":"<commentId or postId>","message":"…"}` |
| Like a post or comment (W) | `FACEBOOK_LIKE_POST_OR_COMMENT` | `{"object_id":"<id>"}`. LIKE is the only reaction the API can add |
| Hide or edit a comment (W) | `FACEBOOK_UPDATE_COMMENT` | `{"comment_id":"<id>","page_id":"$pageId","is_hidden":true}` (or `message`) |
| Delete a comment (W) | `FACEBOOK_DELETE_COMMENT` | `{"comment_id":"<id>","page_id":"$pageId"}` |
| Reactions on a post | `FACEBOOK_GET_POST_REACTIONS` | `{"post_id":"<postId>","summary":true}` |
| Messenger conversations | `FACEBOOK_GET_PAGE_CONVERSATIONS` | `{"page_id":"$pageId","limit":25,"fields":"id,updated_time,participants,unread_count"}` |
| Messages of a conversation | `FACEBOOK_GET_CONVERSATION_MESSAGES` | `{"page_id":"$pageId","conversation_id":"<id>","fields":"id,created_time,from,to,message"}` |
| Send a Messenger message (W) | `FACEBOOK_SEND_MESSAGE` | `{"page_id":"$pageId","recipient_id":"<PSID from the conversation>","message_text":"…","messaging_type":"RESPONSE"}` |
| Page insights | `FACEBOOK_GET_PAGE_INSIGHTS` | `{"page_id":"$pageId","metrics":"page_media_view,page_total_media_view_unique,page_post_engagements,page_follows,page_daily_follows_unique","period":"day","since":"<unix seconds as text>","until":"<unix seconds as text>"}` |
| Post insights | `FACEBOOK_GET_POST_INSIGHTS` | `{"post_id":"<postId>","metrics":"post_media_view,post_total_media_view_unique"}` |

Pitfalls:
- **A reply needs the bare comment id.** `GET_COMMENTS` returns ids as `<postId>_<commentId>`. Pass only the part after the last `_` to `CREATE_COMMENT`, `LIKE_POST_OR_COMMENT` and the other comment actions. With the full id, the action reads `<postId>` as a Page and fails with "not found in your managed pages".
- **A comment on a post** takes the full post id (`<pageId>_<postId>`) as `object_id`.
- **`like_count` counts only 👍.** To know whether anyone reacted, ask for `reactions.summary(total_count)`.
- **Error `#10`** also means "the object does not exist", for example a deleted post. It is not only a missing permission.
- **Skip comments made by the Page itself:** `from.id` equals `$pageId`. A reply to them would answer ourselves.
- **`from` is an object**, `{ "id", "name" }`, and it can be missing for some commenters. Greet by first name when it is there, without a name when it is not. Never invent one.
- **Already answered?** `GET_COMMENTS` with the comment id as `object_id` lists its replies. If one has `from.id` equal to `$pageId`, the comment was answered.
- **Paging.** When the result has `paging.cursors.after`, pass it back as `after` for the next page.
- **Insights dates are text.** `since` and `until` are unix seconds sent as a string, at most 90 days apart, and `until` is exclusive. An empty `{}` in the result means missing data, not zero.
- **Messenger has its own rules.** Answer only inside an existing conversation and within the 24h window. Outside that window the message needs a `tag`, so ask the user.
- **There is no date filter on conversations.** Filter by `updated_time` in the result.
- **"Unanswered"** means the conversation's latest message is not from `$pageId`.
- **Message senders are private people.** Show a name and the text to the user, but do not copy them into files or commits.

## Instagram (only when `instagram.igUserId` is set)

| Task | Slug | Arguments |
|---|---|---|
| Latest posts | `INSTAGRAM_GET_IG_USER_MEDIA` | `{"ig_user_id":"$igUserId","limit":10,"fields":"id,caption,media_type,permalink,timestamp,total_like_count,total_comments_count"}` |
| Comments of a post | `INSTAGRAM_GET_IG_MEDIA_COMMENTS` | `{"ig_media_id":"<mediaId>","fields":"id,text,username,timestamp,like_count,hidden,parent_id"}` |
| Replies to a comment | `INSTAGRAM_GET_IG_COMMENT_REPLIES` | `{"ig_comment_id":"<id>"}` |
| Reply to a comment (W) | `INSTAGRAM_POST_IG_COMMENT_REPLIES` | `{"ig_comment_id":"<id>","message":"…"}` |
| Comment on a post (W) | `INSTAGRAM_POST_IG_MEDIA_COMMENTS` | `{"ig_media_id":"<mediaId>","message":"…"}` |
| Delete our own comment (W) | `INSTAGRAM_DELETE_COMMENT` | `{"ig_comment_id":"<id>"}` |
| DM conversations | `INSTAGRAM_LIST_ALL_CONVERSATIONS` | `{"ig_user_id":"$igUserId","limit":25}` |
| Messages of a DM | `INSTAGRAM_LIST_ALL_MESSAGES` | `{"conversation_id":"<id>","fields":"id,from,to,message,created_time"}` |
| Answer a DM (W) | `INSTAGRAM_SEND_TEXT_MESSAGE` | `{"ig_user_id":"$igUserId","recipient_id":"<IGSID>","text":"…"}` |
| Post insights | `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` | `{"ig_media_id":"<mediaId>","metric":["views","reach","likes","comments","saved","shares","total_interactions"]}` |
| Account insights | `INSTAGRAM_GET_USER_INSIGHTS` | `{"metric":["reach","views","accounts_engaged","total_interactions"],"period":"day","metric_type":"total_value","since":<unix>,"until":<unix>}` |

Pitfalls:
- **There is no like action on Instagram.** "React" works on the Facebook Page only.
- **Limits on replies and comments:** at most 300 characters, 4 hashtags and 1 URL each.
- **A DM** can only answer an existing conversation, inside Meta's 24h window. Error subcode `2534022` means the window has closed.
- **`INSTAGRAM_GET_USER_INSIGHTS` does not accept `ig_user_id: "me"`.** Pass the numeric id, or omit it.
- **Demographics** need `timeframe` (`this_week` or `this_month`) and 100+ followers.
- **Older media has no insights.** Posts older than 2 years, or published before the account turned professional, have none, and that error is permanent.
- **Deprecated slugs** (`INSTAGRAM_GET_POST_*`, `INSTAGRAM_REPLY_TO_COMMENT`, `INSTAGRAM_GET_USER_MEDIA`, …) are refused by `social.ts`, which names the replacement.
