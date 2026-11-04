const express = require("express");
const { createUser, getUser, listUsers, resetUserPassword, setUserStatus, updateUser } = require("../controllers/users.controller");
const { requirePermission } = require("../auth/middleware");

// Stage 13: /api/users. Mounted only when NOTA_AUTH=1. No DELETE: users are disabled instead.
const router = express.Router();
const manage = requirePermission("users.manage");

router.route("/").get(manage, listUsers).post(manage, createUser);
router.patch("/:id/status", manage, setUserStatus);
router.post("/:id/reset-password", manage, resetUserPassword);
router.route("/:id").get(manage, getUser).put(manage, updateUser);

module.exports = router;
