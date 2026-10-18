import { fileURLToPath } from "node:url";
import { llmFromEnv, McpServer, runJob } from "cron-llm";
import { runDigest } from "./digest.js";

// Entry point: `node dist/main.js [--dry-run]`. supercronic runs it on a schedule.

const SERVER = fileURLToPath(new URL("../node_modules/substack-reader-mcp/dist/cli.js", import.meta.url));

await runJob("substack-digest", async ({ env, dryRun, log }) => {
  const llm = llmFromEnv(env, { tags: ["job:substack-digest"], log });
  // The server gets its own settings (SUBSTACK_*) and TZ, and nothing else from the job's environment.
  const serverEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("SUBSTACK_") || k === "TZ"));
  serverEnv.SUBSTACK_DIGEST_DIR ??= "/data";
  serverEnv.SUBSTACK_READER_HOME ??= "/auth";
  const server = await McpServer.start({
    command: env.SUBSTACK_MCP_COMMAND ?? process.execPath,
    args: env.SUBSTACK_MCP_COMMAND ? [] : [SERVER],
    env: serverEnv,
    onStderr: (line) => log(`server: ${line}`),
  });
  try {
    return await runDigest({
      server,
      llm,
      log,
      dryRun,
      reauth: env.SUBSTACK_REAUTH_HINT ?? "Run `substack-reader-mcp login` on a machine with a browser and copy the new auth.json into the job's auth directory.",
      maxPostChars: positive(env.MAX_POST_CHARS),
      maxPicks: positive(env.MAX_PICKS),
      maxPicksPerPublication: positive(env.PICKS_PER_PUBLICATION),
    });
  } finally {
    await server.close();
    log(`tokens: ${llm.usage.prompt_tokens} in, ${llm.usage.completion_tokens} out over ${llm.usage.calls} calls`);
  }
});

/** A positive whole number from env, or undefined for the default. */
function positive(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : undefined;
}
