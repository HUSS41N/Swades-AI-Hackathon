const path = require("node:path");
const { config: loadEnv } = require("dotenv");

loadEnv({ path: path.join(__dirname, "../../apps/server/.env") });

/** @type { import("drizzle-kit").Config } */
module.exports = {
  schema: path.join(__dirname, "src/schema.ts"),
  out: path.join(__dirname, "drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
};
