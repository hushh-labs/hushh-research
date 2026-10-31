/**
 * Cloud Run entrypoint for hushh-mail-api.
 *
 * GCP project: hushh-tech-prod · region us-central1
 * See README.md for the deploy and key-onboarding commands.
 */

import { createApp } from "./src/app.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`hushh-mail-api listening on ${PORT}`);
});

// Cloud Run sends SIGTERM before reclaiming an instance; closing the listener
// lets in-flight sends finish instead of being cut off mid-SMTP.
const shutdown = (signal) => {
  console.log(`hushh-mail-api: received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
