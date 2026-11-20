// Live, read-only check of a Meta ad account with YOUR OWN token. Nothing is saved in Nota, nothing is written to Meta (GET only).
// It prints the account info, the token's permissions, the campaigns and the last 7 days of insights. The token is never printed.
//
//   NOTA_META_TOKEN=<system user token> NOTA_META_ACCOUNT_ID=act_123456789 node scripts/meta-check.mjs
//   optional: NOTA_META_APP_SECRET=<app secret> (when "Require App Secret" is on), NOTA_META_GRAPH_VERSION=v27.0
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient, normalizeAccountId, MetaError, graphVersion } = require("../src/services/meta/metaClient");
const { parseMinor, toMoney } = require("../src/services/meta/metaMoney");

const token = String(process.env.NOTA_META_TOKEN || "").trim();
const adAccountId = normalizeAccountId(process.env.NOTA_META_ACCOUNT_ID);
if (!token || !adAccountId) {
  console.error("Set NOTA_META_TOKEN and NOTA_META_ACCOUNT_ID (act_<digits> or digits). Optional: NOTA_META_APP_SECRET, NOTA_META_GRAPH_VERSION.");
  process.exit(2);
}

const client = createClient({ adAccountId, token, appSecret: String(process.env.NOTA_META_APP_SECRET || "").trim() || undefined });
const section = (title) => console.log(`\n== ${title}`);
const dayString = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

let failed = false;
const step = async (title, fn) => {
  section(title);
  try { await fn(); } catch (error) {
    failed = true;
    // Only our fixed code and message: never Meta's text, a URL or the token.
    console.log(`FAILED: ${error instanceof MetaError ? `${error.code} - ${error.message}` : "unexpected error"}`);
  }
};

console.log(`Graph API ${graphVersion()} - account ${adAccountId} - token ...${token.slice(-4)} (read-only)`);

let currency = "";
await step("Account", async () => {
  const account = await client.account();
  currency = String(account.currency || "");
  console.log({ name: account.name, currency: account.currency, timezone_name: account.timezone_name, account_status: account.account_status, disable_reason: account.disable_reason });
  if (Number(account.account_status) !== 1) console.log("NOTE: the account is not ACTIVE (status 1). Insights are still read.");
});

await step("Token permissions", async () => {
  const permissions = await client.permissions();
  console.log({ source: permissions.source, scopes: permissions.scopes, neverExpires: !permissions.expiresAt, expiresAt: permissions.expiresAt ? new Date(permissions.expiresAt * 1000).toISOString() : null });
  if (!permissions.scopes.includes("ads_read")) console.log("WARNING: ads_read is missing. Nota cannot connect without it.");
});

await step("Campaigns", async () => {
  const campaigns = await client.campaigns();
  console.log(`${campaigns.length} campaigns`);
  for (const row of campaigns.slice(0, 30)) console.log(`  ${row.id}  ${row.effective_status || row.status}  ${row.objective || ""}  ${row.name}`);
  if (campaigns.length > 30) console.log(`  ... and ${campaigns.length - 30} more`);
});

await step("Insights, last 7 days (level=campaign, time_increment=1)", async () => {
  const rows = await client.insights(dayString(-6), dayString(0));
  console.log(`${rows.length} rows`);
  for (const row of rows) {
    const minor = parseMinor(row.spend);
    console.log(`  ${row.date_start}  ${row.campaign_id}  spend ${minor === null ? "?" : toMoney(minor)} ${currency}  impressions ${row.impressions}  reach ${row.reach}  clicks ${row.clicks}  link clicks ${row.inline_link_clicks}  ${row.campaign_name}`);
  }
});

console.log(failed ? "\nDone with problems (see above)." : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
