// Stage 13: createdBy / updatedBy for formatted responses (invoices, payments). Only the fields a
// document actually has are returned, so with auth off (nothing set) the response shape is unchanged.
const ACTOR_KEYS = ["createdBy", "createdByName", "updatedBy", "updatedByName"];

const actorFields = (doc) => {
  const fields = {};
  if (!doc) return fields;
  for (const key of ACTOR_KEYS) {
    if (doc[key] !== undefined && doc[key] !== null) fields[key] = doc[key];
  }
  return fields;
};

module.exports = { actorFields };
