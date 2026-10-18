# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **The job drives substack-reader-mcp over MCP; it doesn't import it.** The server stays a plain MCP server that other people use from agent hosts. If the job needs something from it, add it as an MCP feature (as `digest_begin`'s `structuredContent` was, in 0.5.0), not as a library export.
- **The work list comes from `structuredContent`, not from parsing `digest_begin`'s text.** The text is written for a model and may change. `digest_finish`'s text is still split at the `===== DIGEST` line; that line is part of the server's documented contract.
- **No agent loop here, on purpose.** The Substack digest reads every post, so there's no choice for a model to make about which tool to call. Each model call is one structured question. Medium's digest, which shortlists, may need cron-llm's `runLoop`; this one doesn't.
- **Errors are split by kind.** `StructuredOutputError` (a bad answer) costs one post its gist or falls back to depth for the picks. `McpToolError` from `read_post` makes that post "unreadable". Anything else (gateway down, server crash) throws, so `runJob` sends a failure notice and nothing is saved. Don't catch broadly: a digest of gist-less entries saved as "reported" loses those posts for good.
- **A dry run still writes `current_run.json`** (that's `digest_begin`), but `digest_finish` saves nothing. A real run within 90 minutes continues that run instead of fetching again.
- Only `SUBSTACK_*` variables and `TZ` reach the server, so the LLM key and webhooks don't. Without `TZ` the digest's times come out in UTC (seen in the first container dry run, 2026-10-18).
- **A classifier failure doesn't stop the run**: the server ranks nothing and says so in `digest_begin`'s `CLASSIFIER:` line (e.g. `unavailable … HTTP 401` for a bad `SUBSTACK_JEV_API_KEY`). The job logs that line; check `docker logs` after changing keys.
- Keep personal details out of the repo (it's public): no host paths, time zone, webhook URLs or keys. They live in `docker/.env`, which is gitignored.
