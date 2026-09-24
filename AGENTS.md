# Grove Mail CLI

This repository contains only the public HTTP client, its versioned API descriptions, client documentation and tests. Never copy server implementations, production deployment scripts, server addresses other than the public API URL, credentials, mail content or operational reports here.

The Grove service lives in a separate repository. Refresh `docs/reference/grove-mail-api.json` with its `scripts/export-cli-schema.ts`; this client must build and test without that checkout. Keep the AgentMail 1.5.0 compatibility baselines and provenance intact.

Run `npm test`, `npm run build`, and `npm run verify:package` after a client/package change. Set `AGENTMAIL_CLI` to an unmodified 1.5.0 executable to run optional upstream comparisons. These tests use local synthetic HTTP fixtures and no real credentials. Never publish to npm or change repository visibility without user authorization.
