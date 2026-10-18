import { McpToolError, StructuredOutputError } from "cron-llm";
import { z } from "zod";
import { chatPrompt, chatSummary, type Limits, type PickCandidate, picksPrompt, picksSchema, type PostVerdict, postPrompt, postVerdict } from "./prompts.js";

// One digest run: digest_begin, read every post and ask for a verdict on each,
// summarize each chat, choose the picks, then digest_finish. The server owns
// refs, layout and state; this file owns the order of calls and the checks on
// what the model returns.

/** The parts of cron-llm's McpServer and Llm a run uses, so tests can fake them. */
export interface DigestServer {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  callStructured<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<{ value: T; text: string }>;
}
export interface DigestLlm {
  structured<S extends z.ZodType>(schema: S, prompt: { system?: string; user: string }, opts?: { name?: string; tags?: string[] }): Promise<z.infer<S>>;
}

export interface DigestOptions {
  server: DigestServer;
  llm: DigestLlm;
  log: (line: string) => void;
  /** digest_finish with dry_run: the message is laid out and nothing is saved. */
  dryRun?: boolean;
  /** Sent instead of a digest when the Substack session has expired. */
  reauth?: string;
  /** Characters of one post the model sees; read_post pages are fetched up to this. */
  maxPostChars?: number;
  maxPicksPerPublication?: number;
  maxPicks?: number;
}

/** digest_begin's structuredContent (substack-reader-mcp 0.5.0+). Extra fields are ignored. */
export const WorkList = z.object({
  run_id: z.string(),
  resumed: z.boolean(),
  posts: z.array(
    z.object({
      ref: z.string(),
      status: z.enum(["read", "low", "skipped"]),
      url: z.string(),
      title: z.string(),
      publication: z.string(),
      paywalled: z.boolean(),
      type: z.string(),
      rank: z.number().optional(),
    }),
  ),
  chats: z.array(z.object({ ref: z.string(), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) })),
  interests: z.string(),
  warnings: z.array(z.string()),
  /** substack-reader-mcp 0.7.0+; older servers get their fixed limits. */
  limits: z.object({ gist: z.number(), why: z.number(), topics: z.number(), for_user: z.number() }).default({ gist: 500, why: 300, topics: 500, for_user: 300 }),
});
export type WorkList = z.infer<typeof WorkList>;

export const DIGEST_MARKER = "===== DIGEST";
const PREVIEW_NOTE = "Only a preview was returned";
const MORE = /\[Showing characters \d+–(\d+) of (\d+)\. Call read_post again with start=(\d+) to continue\.\]\s*$/;
const AUTH = /Authentication required|Not logged in|session was rejected/i;

type PostEntry =
  | { ref: string; section: "pick"; gist: string; why: string; preview_only: boolean }
  | { ref: string; section: "other"; gist?: string; preview_only: boolean }
  | { ref: string; section: "unreadable"; error: string };
type ChatEntry = { id: string; topics: string; for_user: string };

/** Runs the digest and returns the message to post, or null when there's nothing to say. */
export async function runDigest(opts: DigestOptions): Promise<string | null> {
  const { server, llm, log } = opts;
  const maxPostChars = opts.maxPostChars ?? 60_000;

  let work: WorkList;
  try {
    const begin = await server.callStructured("digest_begin", {}, WorkList);
    work = begin.value;
    // The classifier's status is only in the text (e.g. a rejected key shows as "unavailable").
    const classifier = /^CLASSIFIER: .*$/m.exec(begin.text)?.[0];
    if (classifier) log(classifier);
  } catch (err) {
    if (err instanceof McpToolError && AUTH.test(err.message)) {
      log(`digest_begin: ${err.message}`);
      return `📬 Substack digest skipped — session expired.${opts.reauth ? ` ${opts.reauth}` : ""}`;
    }
    throw err;
  }
  const toRead = work.posts.filter((p) => p.status === "read");
  log(`run ${work.run_id}${work.resumed ? " (continued)" : ""}: ${toRead.length} posts to read, ${work.posts.length - toRead.length} low or skipped, ${work.chats.length} chats`);
  for (const w of work.warnings) log(`warning: ${w}`);
  const tags = [`run:${work.run_id}`];
  const limits: Limits = work.limits;
  const PostVerdict = postVerdict(limits);
  const ChatSummary = chatSummary(limits);

  const verdicts = new Map<string, { verdict?: PostVerdict; previewOnly: boolean }>();
  const entries = new Map<string, PostEntry>();
  for (const [i, post] of toRead.entries()) {
    let read: { text: string; previewOnly: boolean; truncated: boolean };
    try {
      read = await readPost(server, post.ref, maxPostChars);
    } catch (err) {
      if (!(err instanceof McpToolError)) throw err;
      log(`${post.ref}: read_post failed: ${err.message}`);
      entries.set(post.ref, { ref: post.ref, section: "unreadable", error: err.message.slice(0, 300) });
      continue;
    }
    const { previewOnly } = read;
    try {
      const verdict = await llm.structured(PostVerdict, postPrompt({ text: read.text, truncated: read.truncated, interests: work.interests, limits }), { name: "post_verdict", tags: [...tags, "step:post"] });
      verdicts.set(post.ref, { verdict, previewOnly });
      log(`${post.ref} (${i + 1}/${toRead.length}): depth ${verdict.depth}, ${verdict.type}${previewOnly ? ", preview only" : ""}`);
    } catch (err) {
      // One bad answer costs that post its gist, not the whole digest. A gateway error still ends the run.
      if (!(err instanceof StructuredOutputError)) throw err;
      log(`${post.ref}: no usable verdict: ${err.message}`);
      verdicts.set(post.ref, { previewOnly });
    }
  }

  const chats: ChatEntry[] = [];
  const discussed: string[] = [];
  for (const chat of work.chats) {
    try {
      const activity = await server.call("get_chat_activity", chat.arguments);
      const s = await llm.structured(ChatSummary, chatPrompt(chat.name, activity, limits), { name: "chat_summary", tags: [...tags, "step:chat"] });
      chats.push({ id: chat.id, topics: s.topics, for_user: s.for_user || "none" });
      discussed.push(...s.posts_discussed);
      log(`${chat.ref}: summarized`);
    } catch (err) {
      if (!(err instanceof McpToolError || err instanceof StructuredOutputError)) throw err;
      log(`${chat.ref}: not summarized: ${err.message}`);
    }
  }

  const candidates: PickCandidate[] = [];
  for (const post of toRead) {
    const v = verdicts.get(post.ref)?.verdict;
    if (!v) continue;
    candidates.push({
      ref: post.ref,
      title: post.title,
      publication: post.publication,
      type: v.type,
      depth: v.depth,
      why: v.why,
      gist: v.gist,
      previewOnly: verdicts.get(post.ref)!.previewOnly,
      rank: post.rank,
      discussed: discussed.some((d) => mentions(d, post)),
    });
  }
  const picks = await choosePicks(opts, candidates, work.interests, tags, limits);
  log(`picks: ${picks.map((p) => p.ref).join(", ") || "none"}`);

  const posts: PostEntry[] = [];
  for (const pick of picks) {
    const c = candidates.find((x) => x.ref === pick.ref)!;
    posts.push({ ref: c.ref, section: "pick", gist: c.gist, why: pick.why, preview_only: c.previewOnly });
  }
  const picked = new Set(picks.map((p) => p.ref));
  for (const post of toRead) {
    if (picked.has(post.ref)) continue;
    const e = entries.get(post.ref);
    if (e) {
      posts.push(e);
      continue;
    }
    const v = verdicts.get(post.ref);
    posts.push({ ref: post.ref, section: "other", ...(v?.verdict ? { gist: v.verdict.gist } : {}), preview_only: v?.previewOnly ?? false });
  }

  const out = await server.call("digest_finish", { run_id: work.run_id, posts, chats, dry_run: Boolean(opts.dryRun) });
  const at = out.indexOf(DIGEST_MARKER);
  if (at < 0) throw new Error(`digest_finish returned no message:\n${out.slice(0, 1000)}`);
  for (const line of out.slice(0, at).trim().split("\n")) if (line.trim()) log(line);
  const message = out.slice(out.indexOf("\n", at) + 1).trim();
  return message === "[SILENT]" ? null : message;
}

/**
 * Pages through read_post until the end of the post or about `maxChars`. Only
 * the first page carries the header (title, byline, preview warning).
 */
export async function readPost(server: DigestServer, ref: string, maxChars: number): Promise<{ text: string; previewOnly: boolean; truncated: boolean }> {
  let text = await server.call("read_post", { url: ref, max_chars: Math.min(maxChars, 40_000) });
  // The header's preview warning is on the first page, before any body text.
  const previewOnly = text.includes(PREVIEW_NOTE);
  for (;;) {
    const more = MORE.exec(text);
    if (!more) return { text: text.trimEnd(), previewOnly, truncated: false };
    text = text.slice(0, more.index).replace(/\n*---\s*$/, "");
    if (text.length >= maxChars) return { text, previewOnly, truncated: true };
    text += await server.call("read_post", { url: ref, start: Number(more[3]), max_chars: Math.min(Math.max(maxChars - text.length, 1000), 40_000) });
  }
}

/** The model's picks, checked: known refs, no repeats, per-publication and total caps. */
async function choosePicks(opts: DigestOptions, candidates: PickCandidate[], interests: string, tags: string[], limits: Limits): Promise<{ ref: string; why: string }[]> {
  const perPub = opts.maxPicksPerPublication ?? 2;
  const max = opts.maxPicks ?? 10;
  if (!candidates.length) return [];
  let proposed: { ref: string; why: string }[];
  try {
    proposed = (await opts.llm.structured(picksSchema(limits, max), picksPrompt(candidates, interests, perPub, max, limits), { name: "picks", tags: [...tags, "step:picks"] })).picks;
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    opts.log(`picks: no usable answer (${err.message}); falling back to depth`);
    proposed = [...candidates]
      .filter((c) => c.depth >= 4 && !c.previewOnly && !["link-roundup", "announcement", "podcast-notes"].includes(c.type))
      .sort((a, b) => b.depth - a.depth || (b.rank ?? 50) - (a.rank ?? 50))
      .map((c) => ({ ref: c.ref, why: c.why }));
  }
  const byRef = new Map(candidates.map((c) => [c.ref.toUpperCase(), c]));
  const perPublication = new Map<string, number>();
  const out: { ref: string; why: string }[] = [];
  for (const p of proposed) {
    const c = byRef.get(p.ref.trim().toUpperCase());
    if (!c) {
      opts.log(`picks: ignoring unknown ref ${p.ref}`);
      continue;
    }
    if (out.some((o) => o.ref === c.ref)) continue;
    const n = perPublication.get(c.publication) ?? 0;
    if (n >= perPub || out.length >= max) continue;
    perPublication.set(c.publication, n + 1);
    out.push({ ref: c.ref, why: p.why });
  }
  return out;
}

function mentions(d: string, post: { url: string; title: string }): boolean {
  const s = d.trim().toLowerCase();
  if (!s || s === "none") return false;
  const url = post.url.toLowerCase().replace(/[?#].*$/, "");
  return s.includes(url) || s.includes(post.title.toLowerCase()) || (s.length >= 12 && post.title.toLowerCase().includes(s));
}
