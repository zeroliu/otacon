#!/usr/bin/env node
import { VERSION } from "../shared/version.js";

// M1a stub: the HTTP server lands in M1f.
process.stdout.write(
  `${JSON.stringify({ app: "otacond", version: VERSION, status: "stub" })}\n`,
);
