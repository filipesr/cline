/**
 * social.ts against a fake Composio MCP: the project's account and ids go into the call, writes
 * need --write, publishing and deprecated actions are refused, and each run is recorded.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = `test-social-${process.pid}`;
const PROJECT_DIR = join(ROOT, "projects", PROJECT);
const LOG = join(PROJECT_DIR, "composio-calls.jsonl");

type Call = { slug: string; account?: string; args: Record<string, unknown> };
let calls: Call[] = [];
let server: ReturnType<typeof Bun.serve>;

function writeConfig(igUserId: string | null) {
	writeFileSync(
		join(PROJECT_DIR, "publishing.json"),
		JSON.stringify({
			instagram: {
				composioAccount: igUserId ? "ca_instagram" : null,
				igUserId,
				username: null,
			},
			facebook: {
				mirror: true,
				composioAccount: "ca_facebook",
				pageId: "111",
				name: "Test",
			},
		}),
	);
}

async function run(...args: string[]) {
	const r = Bun.spawn(["bun", join(import.meta.dir, "social.ts"), ...args], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			INSTAGRAM_ENV_FILE: join(ROOT, "does-not-exist.env"),
			COMPOSIO_CONSUMER_API_KEY: "ck_test",
			COMPOSIO_MCP_URL: `http://localhost:${server.port}/mcp`,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(r.stdout).text(),
		new Response(r.stderr).text(),
		r.exited,
	]);
	return { code, stdout, stderr };
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const rpc = (await req.json()) as {
				id?: number;
				method: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
			};
			const sse = (result: unknown) =>
				new Response(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`,
					{
						headers: {
							"content-type": "text/event-stream",
							"mcp-session-id": "s",
						},
					},
				);
			if (rpc.method === "notifications/initialized")
				return new Response(null, { status: 202 });
			if (rpc.method === "initialize") return sse({ capabilities: {} });
			if (rpc.method === "tools/list")
				return sse({
					tools: [
						{
							name: "COMPOSIO_MULTI_EXECUTE_TOOL",
							inputSchema: {
								properties: {
									tools: {
										items: {
											properties: { tool_slug: {}, arguments: {}, account: {} },
										},
									},
								},
							},
						},
						{
							name: "COMPOSIO_MANAGE_CONNECTIONS",
							inputSchema: { properties: {} },
						},
					],
				});
			const tool = (
				rpc.params?.arguments?.tools as {
					tool_slug: string;
					arguments: Record<string, unknown>;
					account?: string;
				}[]
			)[0];
			calls.push({
				slug: tool.tool_slug,
				account: tool.account,
				args: tool.arguments,
			});
			const body = {
				successful: true,
				data: {
					results: [
						{
							index: 0,
							tool_slug: tool.tool_slug,
							response: { successful: true, data: { id: "c_1", ok: true } },
						},
					],
				},
			};
			return sse({ content: [{ type: "text", text: JSON.stringify(body) }] });
		},
	});
	mkdirSync(PROJECT_DIR, { recursive: true });
});

afterAll(() => {
	server.stop(true);
	rmSync(PROJECT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
	calls = [];
	rmSync(LOG, { force: true });
	writeConfig("17841400000000000");
});

setDefaultTimeout(30_000);

describe("social.ts", () => {
	test("a read runs on the project's account, with $pageId filled, and is recorded", async () => {
		const r = await run(
			PROJECT,
			"FACEBOOK_GET_PAGE_POSTS",
			'{"page_id":"$pageId","limit":5}',
		);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ id: "c_1", ok: true });
		expect(calls).toEqual([
			{
				slug: "FACEBOOK_GET_PAGE_POSTS",
				account: "ca_facebook",
				args: { page_id: "111", limit: 5 },
			},
		]);
		const line = JSON.parse(readFileSync(LOG, "utf8").trim());
		expect(line.command).toBe("social");
		expect(line.composioCalls.bySlug).toEqual({ FACEBOOK_GET_PAGE_POSTS: 1 });
	});

	test("a reply without --write is refused before any call", async () => {
		const r = await run(
			PROJECT,
			"FACEBOOK_CREATE_COMMENT",
			'{"object_id":"222","message":"Obrigado!"}',
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("--write");
		expect(calls).toEqual([]);
		expect(existsSync(LOG)).toBe(false);
	});

	test("with --write the reply runs", async () => {
		const r = await run(
			PROJECT,
			"FACEBOOK_CREATE_COMMENT",
			'{"object_id":"222","message":"Obrigado!"}',
			"--write",
		);
		expect(r.code).toBe(0);
		expect(calls[0].slug).toBe("FACEBOOK_CREATE_COMMENT");
	});

	test("publishing and deprecated actions are refused even with --write", async () => {
		for (const slug of [
			"FACEBOOK_CREATE_PHOTO_POST",
			"INSTAGRAM_POST_IG_USER_MEDIA",
			"FACEBOOK_DELETE_POST",
			"INSTAGRAM_GET_POST_COMMENTS",
			"COMPOSIO_MANAGE_CONNECTIONS",
		]) {
			const r = await run(PROJECT, slug, "{}", "--write");
			expect(r.code).toBe(1);
		}
		expect(calls).toEqual([]);
	});

	test("an Instagram action on a project without Instagram stops and says who connects it", async () => {
		writeConfig(null);
		const r = await run(
			PROJECT,
			"INSTAGRAM_GET_IG_USER_MEDIA",
			'{"ig_user_id":"$igUserId"}',
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("composio.dev");
		expect(calls).toEqual([]);
	});
});
