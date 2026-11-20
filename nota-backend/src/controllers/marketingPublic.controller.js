// Online Stage 7A: the two public, anonymous marketing endpoints. Neither stores an IP, a user agent or any customer data.
const asyncHandler = require("../utils/asyncHandler");
const Campaign = require("../models/campaign.model");
const { CampaignClick, CampaignVisit, DEVICES } = require("../models/campaignStat.model");
const { CODE_PATTERN, fullPath } = require("../services/campaigns.service");
const clock = require("../utils/clock");

const codeOf = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const liveCampaign = (code) => (CODE_PATTERN.test(code) ? Campaign.findOne({ code, status: { $ne: "archived" } }).select("code platform type landing").lean() : null);

// POST /api/store/visits { code, sessionId }: once per campaign, local day and browser session (the unique index decides).
const recordVisit = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const campaign = await liveCampaign(codeOf(body.code));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (campaign && /^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) {
    try {
      await CampaignVisit.create({ campaignId: campaign._id, day: clock.localDayString(clock.now()), sessionId });
    } catch (error) {
      if (!(error && error.code === 11000)) throw error;
    }
  }
  // The same answer for any code, so the endpoint cannot be used to probe which codes exist.
  res.json({ ok: true });
});

// POST /api/store/go/:code { device, count? }: counts a click and says where to send the visitor. Unknown or archived code = the home page.
// count:false (the storefront's per-IP throttle is over its limit) still answers the landing path but counts nothing: the visitor is
// ALWAYS sent on, only the number is capped.
const recordClick = asyncHandler(async (req, res) => {
  const campaign = await liveCampaign(codeOf(req.params.code));
  if (!campaign) return res.json({ path: "/" });
  if (req.body && req.body.count === false) return res.json({ path: fullPath(campaign) });
  const input = req.body && typeof req.body.device === "string" ? req.body.device : "other";
  const device = DEVICES.includes(input) ? input : "other";
  await CampaignClick.updateOne(
    { campaignId: campaign._id, day: clock.localDayString(clock.now()), device },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return res.json({ path: fullPath(campaign) });
});

module.exports = { recordVisit, recordClick };
