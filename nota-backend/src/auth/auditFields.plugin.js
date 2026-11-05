// Stage 13: createdBy / updatedBy (+ name copies, so prints keep the name after a rename).
// Set from the signed-in user of the current request (src/auth/context.js). With auth off there
// is no signed-in user, so nothing is set and the documents look exactly as before.
const mongoose = require("mongoose");
const { currentActor } = require("./context");

const actorFields = (prefix) => ({
  [`${prefix}By`]: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  [`${prefix}ByName`]: { type: String, trim: true },
});

/**
 * options.createdOnly: only createdBy/createdByName (e.g. payment entries, which are never edited).
 * options.ignorePaths: a save that changes only these paths keeps updatedBy (e.g. stock moves on
 * Product caused by a sale are not "edits" of the product).
 */
function auditFieldsPlugin(schema, options = {}) {
  const createdOnly = options.createdOnly === true;
  const ignorePaths = new Set(options.ignorePaths || []);

  schema.add(actorFields("created"));
  if (!createdOnly) schema.add(actorFields("updated"));

  schema.pre("save", function setActorOnSave(next) {
    const actor = currentActor();
    if (!actor) return next();
    if (this.isNew) {
      if (!this.createdBy) {
        this.createdBy = actor.id;
        this.createdByName = actor.name;
      }
      if (!createdOnly) {
        this.updatedBy = actor.id;
        this.updatedByName = actor.name;
      }
      return next();
    }
    if (createdOnly) return next();
    // updatedAt/createdAt are set by Mongoose's timestamps before this hook: not an edit by themselves.
    const changed = this.modifiedPaths().filter((p) => !p.startsWith("updatedBy") && p !== "updatedAt" && p !== "createdAt");
    if (changed.length > 0 && changed.some((p) => !ignorePaths.has(p.split(".")[0]))) {
      this.updatedBy = actor.id;
      this.updatedByName = actor.name;
    }
    return next();
  });

  schema.pre("insertMany", function setActorOnInsertMany(next, docs) {
    const actor = currentActor();
    if (!actor) return next();
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
      if (!doc || doc.createdBy) continue;
      doc.createdBy = actor.id;
      doc.createdByName = actor.name;
      if (!createdOnly) {
        doc.updatedBy = actor.id;
        doc.updatedByName = actor.name;
      }
    }
    return next();
  });

  if (createdOnly) return;

  function setActorOnUpdate(next) {
    const actor = currentActor();
    if (!actor) return next();
    const update = this.getUpdate() || {};
    if (Array.isArray(update)) return next(); // aggregation-pipeline updates are not used for these models
    const changedPaths = Object.entries(update)
      .flatMap(([operator, values]) => operator.startsWith("$") && values && typeof values === "object" ? Object.keys(values) : [operator])
      .map((path) => path.split(".")[0])
      .filter((path) => !["updatedAt", "createdAt", "updatedBy", "updatedByName"].includes(path));
    if (changedPaths.length > 0 && changedPaths.every((path) => ignorePaths.has(path))) return next();
    update.$set = { ...(update.$set || {}), updatedBy: actor.id, updatedByName: actor.name };
    if (this.getOptions().upsert) {
      update.$setOnInsert = { ...(update.$setOnInsert || {}), createdBy: actor.id, createdByName: actor.name };
    }
    this.setUpdate(update);
    return next();
  }

  schema.pre("findOneAndUpdate", setActorOnUpdate);
  schema.pre("updateOne", setActorOnUpdate);
}

module.exports = auditFieldsPlugin;
