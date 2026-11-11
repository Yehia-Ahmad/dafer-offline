const ManualEntryDraft = require("../models/manualEntryDraft.model");

// Stage 22: the party lines of POSTED manual entries, read from the ManualEntryDraft documents (never from the ledger), so the
// customer/supplier statements stay computed from documents and the health checks can still fail independently.
// A reversed entry keeps both lines: the original at its date and the mirror at the reversal date.

/**
 * @param {"customer"|"supplier"} partyType
 * @param {Array|null} partyIds null = every party
 * @returns {Promise<Map<string, Array<{ draftId, number, memo, description, date, debit, credit, reversal }>>>} by party id
 */
async function loadManualPartyLines(partyType, partyIds = null, { session = null } = {}) {
  const filter = { status: "posted", lines: { $elemMatch: { partyType, ...(partyIds ? { partyId: { $in: partyIds } } : { partyId: { $ne: null } }) } } };
  const drafts = await ManualEntryDraft.find(filter).sort({ date: 1, createdAt: 1 }).session(session).lean();
  const wanted = partyIds ? new Set(partyIds.map(String)) : null;
  const byParty = new Map();
  for (const draft of drafts) {
    for (const row of draft.lines || []) {
      if (row.partyType !== partyType || !row.partyId) continue;
      const key = String(row.partyId);
      if (wanted && !wanted.has(key)) continue;
      if (!byParty.has(key)) byParty.set(key, []);
      byParty.get(key).push({
        draftId: draft._id, number: draft.number || null, memo: draft.memo || "", description: row.description || "",
        date: draft.date, debit: Number(row.debit || 0), credit: Number(row.credit || 0),
        reversal: draft.reversal ? { date: draft.reversal.date, number: draft.reversal.number || null, reason: draft.reversal.reason || "" } : null,
      });
    }
  }
  return byParty;
}

module.exports = { loadManualPartyLines };
