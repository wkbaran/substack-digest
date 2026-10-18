import { McpToolError, StructuredOutputError } from "cron-llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DIGEST_MARKER, readPost, runDigest, type DigestLlm, type DigestServer } from "../src/digest.js";

const work = {
  run_id: "20261018-120000-ab12",
  since: "2026-10-17T12:00:00Z",
  first_run: false,
  resumed: false,
  posts: [
    { ref: "P1", status: "read", url: "https://a.substack.com/p/one", title: "Replication lag", publication: "Systems", paywalled: false, type: "newsletter", rank: 90 },
    { ref: "P2", status: "read", url: "https://a.substack.com/p/two", title: "Weekly links", publication: "Systems", paywalled: false, type: "newsletter" },
    { ref: "P3", status: "read", url: "https://b.substack.com/p/three", title: "Paywalled essay", publication: "Kitchen", paywalled: true, type: "newsletter" },
    { ref: "P4", status: "read", url: "https://b.substack.com/p/four", title: "Broken", publication: "Kitchen", paywalled: false, type: "newsletter" },
    { ref: "P5", status: "low", url: "https://c.substack.com/p/five", title: "Low", publication: "Other", paywalled: false, type: "newsletter" },
  ],
  chats: [{ ref: "C1", id: "101", kind: "publication", name: "Systems", arguments: { since: "2026-10-17T12:00:00Z", chat_id: "101", transcripts: true } }],
  interests: "## Interests\n- Databases",
  warnings: [],
};

function fakeServer(over: Partial<Record<string, (args: any) => string>> = {}) {
  const calls: { name: string; args: any }[] = [];
  const handlers: Record<string, (args: any) => string> = {
    read_post: ({ url }) => {
      if (url === "P4") throw new McpToolError("read_post", "Error: 404");
      return `# Title ${url}\n\n- URL: x${url === "P3" ? "\n- ⚠️ Only a preview was returned. Either…" : ""}\n\nBody of ${url}.`;
    },
    get_chat_activity: () => "Thread: someone asked about P1",
    digest_finish: () => `STATE SAVED: yes\nWARNINGS: none\n${DIGEST_MARKER}: reply with exactly the text below, nothing before or after =====\n📬 **Substack** — 4 new posts`,
    ...over,
  };
  const server: DigestServer = {
    async call(name, args = {}) {
      calls.push({ name, args });
      return handlers[name]!(args);
    },
    async callStructured<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
      calls.push({ name, args });
      if (over[name]) over[name]!(args);
      return { value: schema.parse(work), text: "RUN_ID: …" };
    },
  };
  return { server, calls };
}

function fakeLlm(answer: (name: string, user: string) => unknown) {
  const asked: { name: string; user: string; tags?: string[] }[] = [];
  const llm: DigestLlm = {
    async structured(schema, prompt, opts) {
      asked.push({ name: opts?.name ?? "", user: prompt.user, tags: opts?.tags });
      const a = answer(opts?.name ?? "", prompt.user);
      if (a instanceof Error) throw a;
      return schema.parse(a);
    },
  };
  return { llm, asked };
}

const verdict = (user: string) =>
  user.includes("Body of P1")
    ? { type: "analysis", gist: "Lag came from a long transaction.", depth: 5, why: "Real numbers." }
    : user.includes("Body of P2")
      ? { type: "link-roundup", gist: "Links.", depth: 2, why: "A list." }
      : { type: "essay", gist: "A teaser.", depth: 4, why: "Original." };

describe("runDigest", () => {
  it("reads every post, summarizes chats, checks the picks and finishes with one entry per post", async () => {
    const { server, calls } = fakeServer();
    const { llm, asked } = fakeLlm((name, user) => {
      if (name === "post_verdict") return verdict(user);
      if (name === "chat_summary") return { topics: "Replication.", for_user: "", posts_discussed: ["https://a.substack.com/p/one"] };
      return { picks: [{ ref: "p1", why: "Best." }, { ref: "P9", why: "Made up." }, { ref: "P1", why: "Again." }, { ref: "P3", why: "Teaser." }] };
    });
    const lines: string[] = [];
    const message = await runDigest({ server, llm, log: (l) => lines.push(l) });

    expect(message).toBe("📬 **Substack** — 4 new posts");
    expect(calls.filter((c) => c.name === "read_post").map((c) => c.args.url)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(asked.find((a) => a.name === "picks")!.user).toMatch(/P1 \| depth 5 \| analysis \| full \| classifier rank 90 \| discussed in a chat/);
    expect(asked.find((a) => a.name === "picks")!.user).toMatch(/P3 \| depth 4 \| essay \| preview only/);
    expect(asked[0]!.tags).toEqual(["run:20261018-120000-ab12", "step:post"]);

    const finish = calls.find((c) => c.name === "digest_finish")!.args;
    expect(finish).toMatchObject({ run_id: work.run_id, dry_run: false });
    expect(finish.posts).toEqual([
      { ref: "P1", section: "pick", gist: "Lag came from a long transaction.", why: "Best.", preview_only: false },
      { ref: "P3", section: "pick", gist: "A teaser.", why: "Teaser.", preview_only: true },
      { ref: "P2", section: "other", gist: "Links.", preview_only: false },
      { ref: "P4", section: "unreadable", error: "Error: 404" },
    ]);
    expect(finish.chats).toEqual([{ id: "101", topics: "Replication.", for_user: "none" }]);
    expect(lines).toContain("picks: ignoring unknown ref P9");
    expect(lines).toContain("STATE SAVED: yes");
  });

  it("keeps at most two picks per publication", async () => {
    const { server, calls } = fakeServer({ read_post: ({ url }) => `# ${url}\n\nBody of P1` });
    const { llm } = fakeLlm((name, user) => (name === "post_verdict" ? verdict(user) : name === "chat_summary" ? { topics: "t", for_user: "none", posts_discussed: [] } : { picks: ["P1", "P2", "P3", "P4"].map((ref) => ({ ref, why: "w" })) }));
    // Make every post the same publication.
    const one = { ...work, posts: work.posts.map((p) => ({ ...p, publication: "Same" })) };
    const s: DigestServer = { ...server, callStructured: async (_n, _a, schema) => ({ value: schema.parse(one), text: "" }) };
    await runDigest({ server: s, llm, log: () => {} });
    const posts = calls.find((c) => c.name === "digest_finish")!.args.posts as { ref: string; section: string }[];
    expect(posts.filter((p) => p.section === "pick").map((p) => p.ref)).toEqual(["P1", "P2"]);
  });

  it("falls back to depth when the picks answer is unusable, and gives a gist-less entry for a bad verdict", async () => {
    const { server, calls } = fakeServer();
    const { llm } = fakeLlm((name, user) => {
      if (name === "post_verdict") return user.includes("Body of P2") ? new StructuredOutputError("bad", "{") : verdict(user);
      if (name === "chat_summary") return { topics: "t", for_user: "none", posts_discussed: [] };
      return new StructuredOutputError("bad", "{");
    });
    await runDigest({ server, llm, log: () => {} });
    const posts = calls.find((c) => c.name === "digest_finish")!.args.posts;
    // P3 is depth 4 but preview-only, so only P1 qualifies.
    expect(posts.filter((p: any) => p.section === "pick").map((p: any) => p.ref)).toEqual(["P1"]);
    expect(posts.find((p: any) => p.ref === "P2")).toEqual({ ref: "P2", section: "other", preview_only: false });
  });

  it("returns the re-auth message when the session expired, and null for [SILENT]", async () => {
    const expired = fakeServer({
      digest_begin: () => {
        throw new McpToolError("digest_begin", "Authentication required: session was rejected");
      },
    });
    const { llm } = fakeLlm(() => ({}));
    expect(await runDigest({ server: expired.server, llm, log: () => {}, reauth: "Log in again." })).toBe("📬 Substack digest skipped — session expired. Log in again.");

    const quiet = fakeServer({ digest_finish: () => `STATE SAVED: yes\n${DIGEST_MARKER} =====\n[SILENT]` });
    const empty = { ...work, posts: [], chats: [] };
    const s: DigestServer = { ...quiet.server, callStructured: async (_n, _a, schema) => ({ value: schema.parse(empty), text: "" }) };
    expect(await runDigest({ server: s, llm, log: () => {}, dryRun: true })).toBeNull();
    expect(quiet.calls.at(-1)!.args).toEqual({ run_id: work.run_id, posts: [], chats: [], dry_run: true });
  });

  it("lets a gateway error end the run", async () => {
    const { server } = fakeServer();
    const { llm } = fakeLlm(() => new Error("http://gw/v1/chat/completions returned 401"));
    await expect(runDigest({ server, llm, log: () => {} })).rejects.toThrow("401");
  });
});

describe("readPost", () => {
  it("pages until the end and drops the paging notes", async () => {
    const pages = [
      "# T\n_sub_\n\n- URL: u\n\nfirst part\n\n---\n[Showing characters 0–10 of 25. Call read_post again with start=10 to continue.]",
      "second par\n\n---\n[Showing characters 10–20 of 25. Call read_post again with start=20 to continue.]",
      "t end",
    ];
    const starts: unknown[] = [];
    const server = { call: async (_n: string, a: any) => (starts.push(a.start), pages.shift()!) } as unknown as DigestServer;
    expect(await readPost(server, "P1", 60_000)).toEqual({ text: "# T\n_sub_\n\n- URL: u\n\nfirst partsecond part end", previewOnly: false, truncated: false });
    expect(starts).toEqual([undefined, 10, 20]);
  });

  it("stops at maxChars", async () => {
    const server = { call: async () => "x".repeat(2000) + "\n\n---\n[Showing characters 0–2000 of 9000. Call read_post again with start=2000 to continue.]" } as unknown as DigestServer;
    const r = await readPost(server, "P1", 1500);
    expect(r.truncated).toBe(true);
  });
});
