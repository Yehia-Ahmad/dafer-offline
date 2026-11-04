const { version: backendVersion } = require("../../package.json");

// Lets offline-edition clients confirm they reached a Nota main PC, that their
// LAN secret is accepted, and whether their app version matches the main PC's.
const getLanInfo = (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    app: "nota-backend",
    lanMode: true,
    appVersion: process.env.NOTA_APP_VERSION || null,
    instanceId: process.env.NOTA_INSTANCE_ID || null,
    backendVersion,
    serverTime: new Date().toISOString(),
  });
};

module.exports = { getLanInfo };
