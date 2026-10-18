import { z } from "zod";

// What the model is asked, and the shape of each answer. Each call is one narrow
// judgment; reading, paging, refs, layout and state belong to the code and the server.

export const POST_TYPES = ["essay", "reporting", "analysis", "tutorial", "link-roundup", "announcement", "podcast-notes", "fiction", "other"] as const;

/**
 * digest_finish's length limits in characters, from digest_begin's `limits`
 * (the server's SUBSTACK_DIGEST_*_MAX settings). They go into every prompt and
 * schema below, so the model is asked for what the server keeps.
 */
export interface Limits {
  gist: number;
  why: number;
  topics: number;
  for_user: number;
}

/** "at most 280 characters (about 45 words)": models count words better than characters. */
export const atMost = (chars: number) => `at most ${chars} characters (about ${Math.max(5, Math.round(chars / 6))} words)`;

export const postVerdict = (l: Limits) =>
  z.object({
    type: z.enum(POST_TYPES),
    gist: z.string().min(1).describe(`1–2 sentences, ${atMost(l.gist)}: the actual argument or findings, not the topic.`),
    depth: z.number().int().min(1).max(5).describe("How much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it."),
    why: z.string().min(1).describe("One sentence justifying depth, naming what's distinctive."),
  });
export type PostVerdict = z.infer<ReturnType<typeof postVerdict>>;

export const chatSummary = (l: Limits) =>
  z.object({
    topics: z.string().min(1).describe(`What's being discussed, ${atMost(l.topics)}.`),
    for_user: z.string().describe(`Any question or mention directed at the reader, ${atMost(l.for_user)}; else "none".`),
    posts_discussed: z.array(z.string()).describe("URLs or titles of posts people are discussing; empty if none."),
  });
export type ChatSummary = z.infer<ReturnType<typeof chatSummary>>;

export const picksSchema = (l: Limits, maxPicks: number) =>
  z.object({
    picks: z
      .array(z.object({ ref: z.string().describe('A ref from the list, e.g. "P3".'), why: z.string().min(1).describe(`One sentence, ${atMost(l.why)}, on why it's worth reading in full.`) }))
      .describe(`Best first. Usually 3–7, never more than ${maxPicks}; none if nothing is strong.`),
  });

const READER =
  "The reader subscribes to these Substack publications; they are a reader, not the author of any of them.";

export function postPrompt(p: { text: string; truncated: boolean; interests: string; limits: Limits }): { system: string; user: string } {
  return {
    system:
      `You read one Substack post for a daily digest and report what it says. ${READER} ` +
      "Judge only from the text given. Don't summarize from the title, and don't describe the topic instead of the argument.",
    user: [
      p.interests ? `The reader's interests (for context only; describe the post as it is):\n${p.interests}` : "",
      "POST",
      p.text,
      p.truncated ? "\n[The post continues; only the part above was given.]" : "",
      "",
      "type: what kind of post this is. A paid podcast with only show notes is podcast-notes.",
      `gist: the actual argument or findings in 1–2 sentences, ${atMost(p.limits.gist)}. Lead with the claim; skip "This post…" and "The author…". For a roundup, name only its main item.`,
      "depth: 1–5, how much is lost by reading only the gist.",
      "why: one sentence justifying depth.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

export function chatPrompt(name: string, activity: string, limits: Limits): { system: string; user: string } {
  return {
    system: `You summarize new activity in one Substack chat for a daily digest. ${READER} Report what people discussed; never write replies.`,
    user: `CHAT: ${name}\n\n${activity}\n\ntopics: what's being discussed, ${atMost(limits.topics)}. Name the main threads; skip who said what.\nfor_user: any question or mention directed at the reader, ${atMost(limits.for_user)}; else "none".\nposts_discussed: URLs or titles of posts people are discussing.`,
  };
}

export interface PickCandidate {
  ref: string;
  title: string;
  publication: string;
  type: string;
  depth: number;
  why: string;
  gist: string;
  previewOnly: boolean;
  rank?: number;
  discussed: boolean;
}

export function picksPrompt(candidates: PickCandidate[], interests: string, maxPerPublication: number, maxPicks: number, limits: Limits): { system: string; user: string } {
  const rows = candidates.map((c) =>
    [
      c.ref,
      `depth ${c.depth}`,
      c.type,
      c.previewOnly ? "preview only" : "full",
      ...(c.rank !== undefined ? [`classifier rank ${c.rank}`] : []),
      ...(c.discussed ? ["discussed in a chat"] : []),
      `${c.title} — ${c.publication}`,
      `gist: ${c.gist}`,
      `depth because: ${c.why}`,
    ].join(" | "),
  );
  return {
    system: `You choose which of today's Substack posts are worth reading in full. ${READER}`,
    user: [
      interests ? `The reader's interests:\n${interests}\n` : "",
      "POSTS (ref | depth 1–5 | type | access | … | title — publication | gist | why that depth):",
      ...rows,
      "",
      "Choose the picks:",
      "- Start with depth 4–5. Rank up posts that match the interests, posts with a high classifier rank, and posts discussed in a chat.",
      "- Rank down link-roundups, announcements and podcast-notes, whatever their depth.",
      "- Rank down preview-only posts: a gist of a teaser isn't a reason to read the whole post.",
      `- At most ${maxPerPublication} picks per publication, and ${maxPicks} in all. Usually 3–7; on a genuinely strong day, more. If nothing is strong, pick none rather than padding.`,
      `List them best first, each with one sentence, ${atMost(limits.why)}, on why it's worth reading in full. Name what's distinctive; don't restate the gist.`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}
