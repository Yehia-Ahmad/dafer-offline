const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { ROLES, isValidPermission } = require("../auth/permissions");

// Stage 13: users of the offline edition (main PC). Passwords and the owner's recovery code are
// stored only as bcrypt hashes.
const BCRYPT_COST = 10;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "اسم المستخدم مطلوب"],
      trim: true,
      maxlength: [100, "يجب ألا يزيد الاسم عن 100 حرف"],
    },
    username: {
      type: String,
      required: [true, "اسم الدخول مطلوب"],
      trim: true,
      lowercase: true,
      maxlength: [50, "يجب ألا يزيد اسم الدخول عن 50 حرفًا"],
      unique: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: { values: ROLES, message: "الدور غير صالح" },
      required: [true, "الدور مطلوب"],
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: (values) => values.every(isValidPermission),
        message: "توجد صلاحية غير معروفة",
      },
    },
    // true when the owner saved an edited permissions list for a template role (manager, cashier,
    // storekeeper, accountant): that list then wins over the template. Not used for owner/custom.
    permissionsEdited: { type: Boolean, default: false },
    // Stage 15: the largest invoice discount this user may give, as a percent of the subtotal.
    // Unset = no limit. Only meaningful with sales.discount; never applied to the owner.
    maxDiscountPercent: {
      type: Number,
      min: [0, "أقصى خصم يجب أن يكون بين 0 و 100"],
      max: [100, "أقصى خصم يجب أن يكون بين 0 و 100"],
    },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    recoveryCodeHash: { type: String }, // owner only
  },
  { timestamps: true }
);

// At most one owner, enforced by MongoDB itself (two setup-owner requests racing cannot both win).
userSchema.index({ role: 1 }, { unique: true, partialFilterExpression: { role: "owner" }, name: "one_owner" });

userSchema.set("toJSON", {
  transform: (_document, returned) => {
    delete returned.passwordHash;
    delete returned.recoveryCodeHash;
    delete returned.tokenVersion;
    delete returned.__v;
    return returned;
  },
});

/** null when the password is acceptable, otherwise the Arabic reason. Arabic and spaces are allowed. */
const passwordProblem = (password) => {
  if (typeof password !== "string") return "كلمة المرور مطلوبة";
  if (password.length < MIN_PASSWORD_LENGTH) return `يجب ألا تقل كلمة المرور عن ${MIN_PASSWORD_LENGTH} أحرف`;
  if (password.length > MAX_PASSWORD_LENGTH) return `يجب ألا تزيد كلمة المرور عن ${MAX_PASSWORD_LENGTH} حرفًا`;
  return null;
};

const hashSecret = (value) => bcrypt.hash(value, BCRYPT_COST);
const compareSecret = (value, hash) =>
  typeof value === "string" && typeof hash === "string" ? bcrypt.compare(value, hash) : Promise.resolve(false);

module.exports = mongoose.model("User", userSchema);
module.exports.BCRYPT_COST = BCRYPT_COST;
module.exports.MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
module.exports.MAX_PASSWORD_LENGTH = MAX_PASSWORD_LENGTH;
module.exports.passwordProblem = passwordProblem;
module.exports.hashSecret = hashSecret;
module.exports.compareSecret = compareSecret;
