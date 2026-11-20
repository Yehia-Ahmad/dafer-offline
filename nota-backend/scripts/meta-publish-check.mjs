// Live check of the PUBLISHING side of a Meta ad account with YOUR OWN token (Online Stage 7C). Run it before using the wizard.
//   NOTA_META_TOKEN=<system user token> NOTA_META_ACCOUNT_ID=act_123456789 node scripts/meta-publish-check.mjs [--create]
//   optional: NOTA_META_APP_SECRET=<app secret> (when "Require App Secret" is on), NOTA_META_GRAPH_VERSION=v27.0
//
// 1. reads the account, the Page(s), the Instagram account(s) and the token scopes (GET);
// 2. sends a campaign create with execution_options=["validate_only"] and prints the result (creates nothing);
// 3. ONLY with --create: creates one campaign, PAUSED, named «Nota test – delete me [nota:check]», with NO ad set and NO ad, prints its id,
//    then sets it to DELETED and confirms.
// It never creates an ad set or an ad, so it can never spend. It never prints the token. Meta never takes money from Nota.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient, normalizeAccountId, MetaError, graphVersion } = require("../src/services/meta/metaClient");
const { createWriter } = require("../src/services/meta/metaWriter");
const { PUBLISH_SCOPES, currencySupported } = require("../src/services/meta/metaPublish.service");

const token = String(process.env.NOTA_META_TOKEN || "").trim();
const adAccountId = normalizeAccountId(process.env.NOTA_META_ACCOUNT_ID);
const create = process.argv.includes("--create");
if (!token || !adAccountId) {
  console.error("Set NOTA_META_TOKEN and NOTA_META_ACCOUNT_ID (act_<digits> or digits). Optional: NOTA_META_APP_SECRET, NOTA_META_GRAPH_VERSION. Add --create to also create and delete one PAUSED test campaign.");
  process.exit(2);
}

const appSecret = String(process.env.NOTA_META_APP_SECRET || "").trim() || undefined;
const reader = createClient({ adAccountId, token, appSecret });
// The only object the writer may touch in this script is the one created below.
let createdId = null;
const writer = createWriter({ adAccountId, token, appSecret, ownsObject: async (id) => id === createdId });
const section = (title) => console.log(`\n== ${title}`);
let failed = false;
const step = async (title, fn) => {
  section(title);
  try { await fn(); } catch (error) {
    failed = true;
    // Only our fixed code and message: never Meta's text, a URL or the token.
    console.log(`FAILED: ${error instanceof MetaError ? `${error.code} - ${error.message}` : "unexpected error"}`);
  }
};

console.log(`Graph API ${graphVersion()} - account ${adAccountId} - token ...${token.slice(-4)} (${create ? "will create and delete ONE paused test campaign" : "validate only, nothing is created"})`);

let currency = "";
let minDaily = null;
await step("Account", async () => {
  const account = await reader.account();
  currency = String(account.currency || "").toUpperCase();
  console.log({ name: account.name, currency, timezone_name: account.timezone_name, account_status: account.account_status, disable_reason: account.disable_reason });
  console.log(currencySupported(currency) ? `Currency ${currency}: supported for publishing from Nota.` : `NOTE: currency ${currency} is not supported for publishing from Nota (v1 supports offset-100 currencies only).`);
  if (Number(account.account_status) !== 1) console.log("NOTE: the account is not ACTIVE (status 1): Meta will not run ads until it is fixed in Ads Manager.");
  minDaily = await reader.minDailyBudget();
  console.log(minDaily ? `Minimum daily budget: ${minDaily / 100} ${currency}` : "Minimum daily budget: Meta does not expose it here (Meta's own error will say if a budget is too low).");
});

await step("Token permissions", async () => {
  const permissions = await reader.permissions();
  console.log({ source: permissions.source, scopes: permissions.scopes, neverExpires: !permissions.expiresAt });
  const missing = PUBLISH_SCOPES.filter((scope) => !permissions.scopes.includes(scope));
  console.log(missing.length ? `Publishing is OFF: missing ${missing.join(", ")}` : "Publishing permissions: all four granted.");
});

await step("Pages (promote_pages)", async () => {
  const pages = await reader.promotePages();
  console.log(`${pages.length} pages`);
  for (const page of pages) console.log(`  ${page.id}  ${page.name}`);
  if (!pages.length) console.log("NOTE: no Page. Add the Facebook Page as an asset of the system user (Business Settings).");
});

await step("Instagram accounts (connected_instagram_accounts)", async () => {
  const accounts = await reader.instagramAccounts();
  console.log(`${accounts.length} accounts`);
  for (const account of accounts) console.log(`  ${account.id}  ${account.username || ""}`);
  if (!accounts.length) console.log("None from the ad account. Nota then falls back to the Page's instagram_business_account.");
});

await step("Campaign create with validate_only (creates nothing)", async () => {
  const { body } = await writer.validateCampaign({
    name: "Nota test – delete me [nota:check]", objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [],
    buying_type: "AUCTION", bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: Math.max(minDaily || 0, 10000),
  });
  console.log("validate_only result:", JSON.stringify(body));
});

if (create) {
  await step("Create ONE paused test campaign (no ad set, no ad), then delete it", async () => {
    const { body } = await writer.createCampaign({
      name: "Nota test – delete me [nota:check]", objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [],
      buying_type: "AUCTION", bid_strategy: "LOWEST_COST_WITHOUT_CAP", daily_budget: Math.max(minDaily || 0, 10000),
    });
    createdId = String(body.id);
    console.log(`Created campaign ${createdId} (PAUSED, nothing can spend: it has no ad set).`);
    await writer.updateObject(createdId, { status: "DELETED" });
    const after = await reader.object(createdId, "id,status,effective_status");
    console.log(`Set to DELETED. Meta now says: status=${after.status}, effective_status=${after.effective_status}`);
  });
}

section("App mode");
console.log("Check in the Meta App Dashboard that the app is in LIVE mode (not Development). Ads created by an app in Development mode may not deliver.");
console.log("Nota cannot read the app mode from the Graph API with a system-user token, so it is not checked here.");

section("Privacy policy URL (Live mode asks for one)");
const publicUrl = String(process.env.NOTA_PUBLIC_URL || "").trim().replace(/\/+$/, "");
if (!publicUrl) {
  console.log("NOTA_PUBLIC_URL is not set in this environment: use https://<your shop domain>/privacy as the app's Privacy Policy URL.");
} else {
  console.log(`Use ${publicUrl}/privacy as the app's Privacy Policy URL (Settings > Basic in the App Dashboard).`);
  try {
    const answer = await fetch(`${publicUrl}/privacy`, { signal: AbortSignal.timeout(8000) });
    console.log(answer.status === 200 ? "The page answers 200: Meta can read it." : `NOTE: the page answered ${answer.status}. Meta needs 200 (a closed website answers 503).`);
  } catch {
    console.log("NOTE: could not reach that address from here (it only has to be reachable from the internet).");
  }
}

console.log(failed ? "\nDone with problems (see above)." : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
