# Online Stage 7C — Create Facebook/Instagram campaigns from Nota

Branch: `marketing` (7B committed). Read before starting:
- docs/ONLINE_PLAN.md (7A and 7B sections), docs/stages/ONLINE_STAGE_7A.md, docs/stages/ONLINE_STAGE_7B.md
- nota-backend: src/services/meta/* (metaClient, metaSync, metaResults, metaMoney), src/utils/secretBox.js, the MetaConnection / MetaCampaign / ExchangeRate models, controllers/metaConnection.controller.js and metaLinks.controller.js, services/campaigns.service.js (`fullPath`, the UTM link), the Campaign model, the Product model (`website.images`), the marketing settings (pixel id), src/auth/permissions.js, src/auth/audit.js, test/online-stage7b.test.js
- nota-frontend: the marketing module (campaign page, link dialog, results), the Meta connection card, the help sections meta-connection, campaigns and marketing-results, scripts/export-help.mjs, scripts/mobile-audit.mjs
- Meta docs (read them, don't guess; note the date you checked): Marketing API v27.0 changelog, basic ad creation (campaign → ad set → creative → ad), Ad Campaign, Ad Set, Ad Creative and `object_story_spec`/`link_data`, Ad Image (`/act_<id>/adimages`), Advantage+ audience (`targeting_automation.advantage_audience`), Advantage+ campaign budget, `special_ad_categories`, `execution_options: ["validate_only"]`, targeting search (`/search?type=adgeolocation`), `/act_<id>/promote_pages`, the ad account's Instagram accounts, `/act_<id>/adspixels`, `generatepreviews`, currency offsets, error codes and rate limits.

Start in plan mode and show me the plan (STEP 0) before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
7B reads the shop's own ad account (GET only). In 7C the owner creates a simple Facebook/Instagram campaign **from inside Nota**, using the same per-shop token, and Nota links it to the Nota campaign automatically so 7A/7B results work with no extra step. **This is the first code that can make the shop spend money.** Every decision below is about keeping that safe: nothing runs until the owner switches it on, budgets have a ceiling, and Nota only ever touches what Nota created.

Meta never takes money from Nota: the ad account pays with the card set in Ads Manager. Nota sends no payment data and calls no billing endpoint.

## Decisions (already made; implement exactly)

### 1. Permissions and token
- New permission `marketing.publish` («نشر وتشغيل إعلانات فيسبوك»), **owner only** in the role templates (like `marketing.connect`; the manager does not get it). It covers creating, switching on/off and changing budgets. The 55th permission: update the hard-coded counts in the tests and the help catalog.
- Publishing needs, on the token: `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list` (confirm the exact list in the v27 docs and tell me in STEP 0). `ads_read` alone keeps 7B working and publishing off.
- The connection card shows a mode: «قراءة بس» or «قراءة ونشر», from the stored scopes. When publishing is not possible, the publish button explains what is missing and links to the help step.
- The system user also needs the **Facebook Page** as an asset. The card gets two pickers, saved on `MetaConnection` (needs `marketing.connect`):
  - the Page: from `GET /act_<id>/promote_pages`;
  - the Instagram account (optional): from the ad account's Instagram accounts (check the current edge name in the docs; fall back to the Page's `instagram_business_account`).
  Without a Page there is no publishing.

### 2. Two separate modules: the reader stays GET only
- `metaClient.js` stays exactly as in 7B: GET only, and its test that fails on anything but GET stays.
- New `services/meta/metaWriter.js`: the only code that sends POST to Meta. It reuses the same error classification, the usage headers and the Bearer header + `appsecret_proof`. It refuses any request outside this **allowlist** (a test proves it):
  - `POST act_<id>/campaigns`, `act_<id>/adsets`, `act_<id>/adcreatives`, `act_<id>/ads`, `act_<id>/adimages`;
  - `POST <object id>` only for ids stored in Nota's own publish records (section 4), and only with the fields `status`, `daily_budget`, `lifetime_budget`, `end_time`, `name`.
  No DELETE (removal is `status=DELETED` on Nota's own objects). No business, user, Page post, catalog, audience or billing endpoint.
- Writes go one at a time, never in parallel, with the same throttling as the reader.
- New error kinds for writes, each with a fixed Arabic message (never Meta's text): budget too low, payment method missing / account not able to run ads, Page not allowed, image rejected, ad policy rejection (show Meta's `error_user_title` only if it is a fixed policy category; otherwise our message), invalid parameter (with the field name only). Say in STEP 0 which codes/subcodes map to which.

### 3. What the owner can create (v1)
A wizard «حملة فيسبوك جديدة» on the page of a Nota campaign whose platform is facebook or instagram (`marketing.publish`). One Meta campaign, one ad set, 1 to 5 ads.

**Goal** (two choices only):
- «زيارات للموقع»: `OUTCOME_TRAFFIC`, ad set `optimization_goal=LINK_CLICKS`, `destination_type=WEBSITE`.
- «مبيعات من الموقع»: `OUTCOME_SALES`, `optimization_goal=OFFSITE_CONVERSIONS`, `promoted_object={pixel_id, custom_event_type: PURCHASE}`. Allowed only when the 7A pixel id is set and that pixel is visible to the ad account (`GET /act_<id>/adspixels`). Show its last fired time if Meta gives it; warn (don't block) when it never fired.

**Campaign:** `special_ad_categories: []`, `buying_type=AUCTION`, **Advantage+ campaign budget** (the budget lives on the campaign), `bid_strategy=LOWEST_COST_WITHOUT_CAP`. Status **PAUSED**. The Meta name is `<Nota campaign name> · <code>` plus a hidden tag `[nota:<publishId>]` at the end (section 4 needs it).

**Budget:** daily (`daily_budget`), or total for a period (`lifetime_budget` + `end_time`). Start time optional (default now). Entered in the ad account's currency, sent in minor units using Meta's currency offset. v1 supports only currencies with offset 100; any other account currency disables publishing with a clear message. When the account is not EGP, show the EGP equivalent with the 7B rate (or «محتاج سعر صرف»).

**Audience:**
- Country Egypt always (`geo_locations.countries=["EG"]`), optionally narrowed to governorates or cities picked from `GET /search?type=adgeolocation` (Egypt only, cached).
- Advantage+ audience **on by default** (`targeting_automation.advantage_audience=1`): min age 18 to 25, no max age (Meta rules when it is on). The owner may turn it off (`advantage_audience=0`) to set age 18–65 and gender. Always send the field explicitly (required since v23).
- No device or OS targeting in v1, so v27's device expansion never applies. Leave a comment saying so.
- Placements: Advantage+ placements (send nothing).

**Ads (1 to 5):** each is a single-image link ad:
- Image: a product's website image from Nota or an uploaded file (jpg/png, at least 600×600, at most 8 MB; warn under 1080×1080). Uploaded once to `act_<id>/adimages` (bytes), the hash cached on the publish record.
- Primary text (required, ≤ 500 chars), headline (≤ 40, warn above), optional description, call to action from a short list: SHOP_NOW («اشتري دلوقتي»), ORDER_NOW, LEARN_MORE, CONTACT_US, GET_OFFER.
- Link: the shop's public website URL built with the 7A `fullPath` of the Nota campaign (the UTM link, **not** the `/go/` short link: Meta's crawler would inflate the click counter). The landing can be the campaign's landing path or a chosen product page. Refuse to publish when the site base URL is not public https (dev, localhost, IP).
- `object_story_spec`: `page_id`, `instagram_user_id` when chosen, `link_data` {image_hash, link, message, name, description, call_to_action}.
- **v27 opt-out:** every creative sends `degrees_of_freedom_spec.creative_features_spec.product_extensions = {enroll_status: "OPT_OUT"}` (Product showcase, which v27 may switch on and which cannot be changed later on that creative). Also check in the docs which other creative enhancements are on by default for API-created link ads; opt out of anything that **rewrites the shop's text** (it is Egyptian Arabic and should stay word for word) and leave visual ones at Meta's default. List in STEP 0 what you found and what you will send. After creating the creative, read it back once (GET, through the reader) and store its `degrees_of_freedom_spec` so the page can show what Meta applied.
- Ad set and ads are created with status ACTIVE under the PAUSED campaign, so **one switch on the campaign** starts or stops everything.

**Preview:** before publishing, the owner can open Meta's own preview per ad (`GET /act_<id>/generatepreviews` with the creative spec, through the reader, feed and Instagram feed formats). It returns an iframe. Allow `frame-src https://www.facebook.com` in the **admin** CSP only (not the storefront). If that turns out messy, say so in STEP 0 and propose a Nota-drawn preview instead.

### 4. Publishing safely: `MetaPublish`
- New model `MetaPublish`: Nota campaign id, the full spec the owner confirmed, the created Meta ids per step (campaign, image hashes, ad set, creatives, ads), a state per step, who and when, and the final status. Unique `publishId`.
- **Validate first:** the campaign spec is sent with `execution_options=["validate_only"]` before anything real; a failure shows in the wizard and nothing is created.
- Then each step runs in order. **Each Meta id is saved the moment Meta returns it.** A retry continues from the first unfinished step and never re-creates a finished one.
- **Unknown result** (timeout or network error after sending a create): before retrying, search the parent for an object whose name carries `[nota:<publishId>]` (GET through the reader). If found, store its id and continue; otherwise retry once.
- A Mongo lock per publish stops double clicks and two tabs.
- If a step fails for good: the campaign stays PAUSED (nothing spends), the wizard shows which step failed and why, and offers «حاول تاني» (continue) or «إلغاء» (sets the created campaign to DELETED and marks the record cancelled).
- On success: upsert the Meta campaign as a `MetaCampaign` linked to the Nota campaign (the 7B link, same one-Meta-to-one-Nota rule), then start a 7B manual sync in the background (ignoring its 5-minute gap for this one call).

### 5. Switching on, and managing afterwards
- The campaign page lists Nota-created Meta campaigns with their status. Actions (`marketing.publish`), only for campaigns Nota created:
  - «تشغيل» (ACTIVE) / «إيقاف» (PAUSED);
  - change the daily or total budget;
  - change the end date;
  - «أرشفة» (ARCHIVED).
- **«تشغيل» needs a confirmation dialog** that states the money in words and numbers: «هيتصرف لحد 300 جنيه في اليوم من بطاقة حساب الإعلانات» (or the total and the end date). The owner ticks a checkbox before the button works.
- Campaigns not created by Nota stay read-only in Nota (manage them in Ads Manager). Say so in the help.
- After any change, refresh the status from Meta (GET) and record it.

### 6. Money ceiling
- New marketing setting «أقصى ميزانية» (`marketing.publish` to edit): max daily budget and max total budget, in EGP. Defaults: 1000 EGP per day, 10000 EGP total. The server refuses a create or a budget change above them (converted with the 7B rate when the account is not EGP; refused when there is no rate). The wizard shows the ceiling next to the field.
- Also check the account's minimum daily budget if Meta exposes it on the ad account (confirm the field); otherwise rely on Meta's error and our fixed message.

### 7. Audit
Every write is an audit entry: create (campaign id, goal, budget type and amount, currency, number of ads), switch on/off, budget change (old → new), end date change, archive, cancel. Never the token, never image bytes, never the ad text (only its length).

### 8. Live check script
`nota-backend/scripts/meta-publish-check.mjs`, run with the owner's own token like `meta-check.mjs`:
1. reads the account, the Page(s), the Instagram account(s) and the token scopes;
2. sends a campaign create with `validate_only` and prints the result;
3. only with `--create`: creates one campaign, **PAUSED**, named «Nota test – delete me [nota:check]», with no ad set, prints its id, then sets it to DELETED and confirms.
It never creates an ad set or an ad, so it can never spend. It never prints the token.

### 9. Help
- Update «ربط حساب إعلانات فيسبوك»: the extra token permissions, adding the Page (and Instagram) to the system user, the mode on the card. Tell the owner that a token with all of them works for both reading and publishing.
- New guide «عمل حملة فيسبوك من نوتا»: when to choose visits vs sales, budgets and the ceiling, the audience defaults, what makes a good image and text, why the link is the UTM link, the preview, publishing, switching on (and that money starts only then), stopping, and where payment happens (the card in Ads Manager, never Nota). Plus a blockers table with every new message.
- Behind the scenes: nothing is posted in Nota's books when Meta spends; the real card charge is still recorded as an ad expense (7B rule). Meta reviews every ad before it runs (it can take hours), and a rejected ad shows its status in Nota.
- Update the role help and the permission catalog for `marketing.publish`; `export-help --check` must pass.

### 10. Not in v1 (list them in ONLINE_PLAN.md as later)
WhatsApp / Messenger message ads, video and carousel, catalog ads, custom and lookalike audiences, editing an ad's text or image after creation (Meta needs a new ad), A/B tests, TikTok ads.

## Tests (backend, fake transport)
- The writer refuses every endpoint outside the allowlist, and refuses `POST <id>` for an id not in a publish record or with a field outside the list. The reader's GET-only test still passes.
- A full publish sends, in order: validate, campaign (PAUSED, `special_ad_categories: []`, campaign budget), images, ad set (with `advantage_audience` explicit), creatives (with `product_extensions` OPT_OUT), ads (ACTIVE); then the link and the sync.
- Retry after a failure at each step continues without duplicates. An unknown result finds the object by its tag and does not re-create it. Double submit → one publish.
- Ceiling: above → refused, at → allowed, non-EGP with rate converts, without rate refused. Currency with offset ≠ 100 → publishing disabled.
- Sales goal refused without a pixel or with a pixel the account cannot see.
- Non-public site URL refused. The link carries the UTM params, never `/go/`.
- Switch on / off / budget / end date / archive only on Nota-created ids; a 7B-synced campaign not created by Nota → refused.
- Permissions: only `marketing.publish` can publish; the manager template does not have it; `marketing.connect` alone cannot publish.
- Error mapping for each new write error; no Meta text, URL or token in any response, log or audit entry.
- Admin specs for the wizard steps, the confirmation dialog (button disabled until the box is ticked), the ceiling hint, the mode on the card, the Nota-created list actions.
- Phone audit at 390 and 1280 for the wizard and the campaign page with the list, with the marketing tab and the wizard actually opened (extend `mobile-audit.mjs` so it can open them, instead of a throwaway script).

## STEP 0 (plan, wait for my approval)
Show me:
1. The exact token permissions for publishing (v27 docs), and whether a Standard/Limited access app can use `pages_manage_ads` for the shop's own Page. Also whether an app in Development mode can create ads that deliver, or must be switched to Live (and what Live needs).
2. The exact request bodies for each step (validate, campaign, image, ad set, creative, ad), with every field.
3. The creative enhancements that are on by default for API link ads in v27, and what you will send for each.
4. The error codes → our fixed messages for writes.
5. The `MetaPublish` model and the step state machine, the lock and the unknown-result search.
6. The files you will add or change, and anything in this brief you think is wrong or risky.

Then build it as approved. Report what you ran and what you did not.
