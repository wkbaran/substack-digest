# substack-digest

A daily digest of every new post in your Substack subscriptions, plus chat activity, posted to a Discord channel. Every post is read in full by a model, which reports what it argues and how much is lost by reading only that; a final call picks the few worth reading in full.

It's a plain scheduled job, not an agent:

- [substack-reader-mcp](https://github.com/wkbaran/substack-reader-mcp) runs as a child process. Its digest tools fetch the posts, number them, lay out the message and keep the state (what was already reported, publications to re-check).
- [cron-llm](https://github.com/wkbaran/cron-llm) calls any OpenAI-compatible gateway with a JSON schema per question, and posts to the Discord webhook.
- The model answers three kinds of narrow questions: one per post (type, gist, depth 1–5, why), one per chat (topics, anything addressed to you), and one for the picks. The code checks every answer: refs must exist, at most two picks per publication, every post gets an entry.

## How a run goes

1. `digest_begin` returns the work list as data: posts (with the classifier's rank, if it's on), chats, and your `interests.md`.
2. Each post is read with `read_post` (paged up to `MAX_POST_CHARS`) and judged. Posts the classifier set aside aren't read.
3. Each chat with activity is read with `get_chat_activity` and summarized.
4. One call chooses the picks from the verdicts. If its answer is unusable, the picks fall back to depth 4–5.
5. `digest_finish` saves state and returns the message, which goes to Discord. `[SILENT]` (nothing new) posts nothing.

An answer that doesn't fit its schema costs that post its gist, not the run. A gateway error or a server crash ends the run with a failure notice, and the next run covers the same period, since state is saved only by `digest_finish`.

## Running it

```sh
npm install
npm run build
cp docker/.env.example .env                    # fill in; the host directories are only for the container
node --env-file=.env dist/main.js --dry-run    # prints the message; digest_finish saves nothing
```

Sign in to Substack once on a machine with a browser (`npx substack-reader-mcp login`), and point `SUBSTACK_READER_HOME` at the directory holding `auth.json`.

### In a container

`docker/` has a Dockerfile, a crontab for [supercronic](https://github.com/aptible/supercronic) (06:00 in the container's `TZ`) and a compose file. Copy `docker/.env.example` to `docker/.env`, set the host directories and the rest, then:

```sh
docker compose -f docker/compose.yaml up -d --build
docker exec substack-digest node /app/dist/main.js --dry-run   # try it now
docker logs substack-digest                                     # one line per step and per model call
```

The container runs as uid 1000; the state and auth directories should belong to it.

## Configuration

| Variable | |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT` | The gateway and model (see cron-llm). Requests are tagged `job:substack-digest`, `run:<run id>` and `step:post` / `step:chat` / `step:picks` for the gateway's logs |
| `DISCORD_WEBHOOK_URL` | Where the digest goes. Without it, the message is printed |
| `DISCORD_FAILURE_WEBHOOK_URL` | Where failure notices go; defaults to the digest webhook |
| `SUBSTACK_*` | Passed to substack-reader-mcp, and nothing else from the job's environment is. `SUBSTACK_DIGEST_DIR` defaults to `/data` and `SUBSTACK_READER_HOME` to `/auth`. See its README for the classifier and the rest |
| `SUBSTACK_REAUTH_HINT` | What to do when the session expires; it's sent in place of the digest |
| `MAX_POST_CHARS` | How much of one post the model reads (default 60000) |
| `JOB_DRY_RUN=1` | Same as `--dry-run` |

## Development

```sh
npm test
```

Node 26 or later. MIT licensed.
