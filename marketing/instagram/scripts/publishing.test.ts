/**
 * The end-to-end flow against a fake Composio: question, decision, project cap, carousel
 * containers, publishing, Facebook Page and the record in post.json. Images and hosting have
 * their own scripts; here the post already arrives with them.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PROJECT = `test-flow-${process.pid}`;
const PROJECT_DIR = join(ROOT, "projects", PROJECT);
const POSTS = join(PROJECT_DIR, "posts");
const COMPOSIO_LOG = join(PROJECT_DIR, "composio-calls.jsonl");

function readComposioLog() {
	return existsSync(COMPOSIO_LOG)
		? readFileSync(COMPOSIO_LOG, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
		: [];
}

type Call = {
	slug: string;
	account: string;
	args: Record<string, unknown>;
};
let calls: Call[] = [];
let server: ReturnType<typeof Bun.serve>;
let quotaUsage = 0;
let activeConnections = 2;
let instagramActive = true;
let pageFails = false;
let connectionRequests: unknown[] = [];

// Async on purpose: a spawnSync would block the fake server, which runs in this process.
async function run(...args: string[]) {
	const r = Bun.spawn(
		["bun", join(import.meta.dir, "publishing.ts"), ...args],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				INSTAGRAM_ENV_FILE: join(ROOT, "does-not-exist.env"),
				COMPOSIO_CONSUMER_API_KEY: "ck_test",
				COMPOSIO_MCP_URL: `http://localhost:${server.port}/mcp`,
			},
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(r.stdout).text(),
		new Response(r.stderr).text(),
		r.exited,
	]);
	return { code, stdout, stderr };
}

function readPost(name: string) {
	return JSON.parse(readFileSync(join(POSTS, name, "post.json"), "utf8"));
}

function createPost(
	name: string,
	options: {
		format?: "post" | "carousel";
		publishing?: Record<string, unknown>;
	} = {},
) {
	const format = options.format ?? "carousel";
	const n = format === "carousel" ? 2 : 1;
	const dir = join(POSTS, name);
	mkdirSync(join(dir, "final"), { recursive: true });
	const chosen = Array.from({ length: n }, (_, i) => {
		const file = `final/0${i + 1}.jpg`;
		writeFileSync(join(dir, file), "jpeg");
		return { n: `0${i + 1}`, file };
	});
	writeFileSync(
		join(dir, "post.json"),
		JSON.stringify({
			project: PROJECT,
			slug: name.slice(11),
			date: name.slice(0, 10),
			format,
			count: n,
			review: { chosen },
			publishing: {
				state: "draft",
				round: 1,
				request: {},
				approvals: [],
				history: [],
				media: chosen.map((c) => ({
					file: c.file,
					url: `https://pub.example.r2.dev/${name}/${c.file}`,
					uploadedAt: new Date().toISOString(),
				})),
				...options.publishing,
			},
		}),
	);
	writeFileSync(
		join(dir, "caption.txt"),
		"A confraternização acontece uma vez.\n\nSolicitar proposta corporativa.\n\n#partyshare #rh #endomarketing",
	);
	writeFileSync(
		join(dir, "caption-facebook.txt"),
		"A confraternização acontece uma vez. Solicitar proposta corporativa: https://www.partyshare.me/business?utm_source=facebook&utm_content=e02\n\n#partyshare #rh",
	);
	return dir;
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		// Speaks Composio's MCP: initialize, tools/list and tools/call of
		// COMPOSIO_MULTI_EXECUTE_TOOL. Answers in SSE, like the real server.
		async fetch(req) {
			if (req.headers.get("x-consumer-api-key") !== "ck_test") {
				return new Response("no", { status: 401 });
			}
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
							"mcp-session-id": "session-1",
						},
					},
				);
			if (rpc.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (rpc.method === "initialize") {
				return sse({ protocolVersion: "2025-06-18", capabilities: {} });
			}
			if (req.headers.get("mcp-session-id") !== "session-1") {
				return new Response("no session", { status: 400 });
			}
			if (rpc.method === "tools/list") {
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
							inputSchema: {
								properties: {
									toolkits: {
										items: { properties: { name: {}, action: {} } },
									},
								},
							},
						},
					],
				});
			}
			const text = (body: unknown) =>
				sse({ content: [{ type: "text", text: JSON.stringify(body) }] });
			if (rpc.params?.name === "COMPOSIO_MANAGE_CONNECTIONS") {
				connectionRequests.push(rpc.params.arguments);
				const account = (status: string) => ({
					status,
					accounts: [{ id: "ca_x", status }],
				});
				return text({
					successful: true,
					data: {
						results: {
							instagram: account(
								instagramActive && activeConnections > 0
									? "active"
									: "initiated",
							),
							facebook: account(activeConnections > 1 ? "active" : "initiated"),
						},
						summary: {
							active_connections: activeConnections,
							initiated_connections: 2 - activeConnections,
						},
					},
				});
			}
			const [item] = rpc.params?.arguments?.tools as {
				tool_slug: string;
				arguments: Record<string, unknown>;
				account?: string;
			}[];
			const slug = item.tool_slug;
			calls.push({
				slug,
				account: item.account ?? "",
				args: item.arguments,
			});
			const ok = (data: unknown) =>
				text({
					successful: true,
					data: {
						results: [
							{
								index: 0,
								tool_slug: slug,
								response: { successful: true, data },
							},
						],
					},
				});
			switch (slug) {
				case "INSTAGRAM_GET_USER_INFO":
					// The Instagram Composio returns belongs to Party Share's business, linked to its Page.
					return ok({ id: "17841499999999999", username: "partyshare_ig" });
				case "INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT":
					return ok({
						data: [
							{
								quota_usage: quotaUsage,
								config: { quota_total: 100, quota_duration: 86400 },
							},
						],
					});
				case "INSTAGRAM_POST_IG_USER_MEDIA":
					return ok({ id: "container1" });
				case "INSTAGRAM_CREATE_CAROUSEL_CONTAINER":
					return ok(
						JSON.stringify({
							id: "carousel1",
							children: [{ id: "c1" }, { id: "c2" }],
						}),
					);
				case "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH":
					return ok({ id: "1790000000001" });
				case "INSTAGRAM_GET_IG_MEDIA":
					return ok({
						id: "1790000000001",
						permalink: "https://www.instagram.com/p/TEST/",
						timestamp: new Date().toISOString(),
						caption:
							"A confraternização acontece uma vez.\n\nSolicitar proposta corporativa.\n\n#partyshare #rh #endomarketing",
					});
				case "FACEBOOK_LIST_MANAGED_PAGES":
					return ok({
						data: [
							{
								id: "1351629444696145",
								name: "Party Share",
								instagram_business_account: { id: "17841499999999999" },
							},
							{ id: "999", name: "il Burger" },
						],
					});
				case "FACEBOOK_CREATE_MULTI_PHOTO_POST":
				case "FACEBOOK_CREATE_PHOTO_POST":
					if (pageFails)
						return text({
							successful: true,
							data: {
								results: [
									{ index: 0, tool_slug: slug, error: "(#200) sem permissão" },
								],
							},
						});
					return ok({ post_id: "111_222" });
				case "FACEBOOK_GET_POST":
					return ok({
						id: "111_222",
						permalink_url: "https://www.facebook.com/111/posts/222",
						created_time: "2026-10-22T23:00:00+0000",
					});
				case "FACEBOOK_DELETE_POST":
					return ok({ success: true });
				default:
					return text({
						successful: true,
						data: {
							results: [
								{ index: 0, tool_slug: slug, error: `unexpected slug ${slug}` },
							],
						},
					});
			}
		},
	});
	mkdirSync(PROJECT_DIR, { recursive: true });
	const config = JSON.parse(
		readFileSync(join(ROOT, "projects/partyshare/publishing.json"), "utf8"),
	);
	config.instagram = {
		composioAccount: "ca_instagram",
		igUserId: "17841400000000000",
		username: "test",
	};
	config.facebook = {
		mirror: true,
		composioAccount: "ca_facebook",
		pageId: "111",
		name: "Test",
	};
	writeFileSync(join(PROJECT_DIR, "publishing.json"), JSON.stringify(config));
	cpSync(
		join(ROOT, "projects/partyshare/campaign.md"),
		join(PROJECT_DIR, "campaign.md"),
	);
});

afterAll(() => {
	server.stop(true);
	rmSync(PROJECT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
	calls = [];
	quotaUsage = 0;
	activeConnections = 2;
	instagramActive = true;
	pageFails = false;
	connectionRequests = [];
	rmSync(POSTS, { recursive: true, force: true });
	rmSync(COMPOSIO_LOG, { force: true });
});

setDefaultTimeout(30_000);

describe("connection", () => {
	test("only lists the connections: action list on each toolkit, never add", async () => {
		await run("connection", PROJECT);
		expect(connectionRequests).toEqual([
			{
				toolkits: [
					{ name: "instagram", action: "list" },
					{ name: "facebook", action: "list" },
				],
			},
		]);
	});

	test("without an active connection, says which is missing instead of failing on an action", async () => {
		activeConnections = 1;
		const r = await run("connection", PROJECT);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("sem conexão ativa no Composio para facebook;");
		expect(calls).toEqual([]);
	});
});

describe("Page only, without Instagram connected", () => {
	test("connection warns, does not call Instagram and pins the Page with --save", async () => {
		instagramActive = false;
		const file = join(PROJECT_DIR, "publishing.json");
		const before = readFileSync(file, "utf8");
		try {
			const r = await run(
				"connection",
				PROJECT,
				"--save",
				"--page",
				"Party Share",
			);
			expect(r.code).toBe(0);
			expect(r.stderr).toContain("seguindo só com a Página");
			expect(calls.map((c) => c.slug)).toEqual(["FACEBOOK_LIST_MANAGED_PAGES"]);
			const config = JSON.parse(readFileSync(file, "utf8"));
			expect(config.facebook.pageId).toBe("1351629444696145");
			expect(config.instagram).toEqual(JSON.parse(before).instagram);
		} finally {
			writeFileSync(file, before);
		}
	});

	test("publish --facebook-only on an approved post publishes only on the Page and counts toward the cap", async () => {
		const dir = await createApproved("2026-10-22-page-only", "post");
		const r = await run("publish", PROJECT, dir, "--facebook-only");
		expect(r.code).toBe(0);
		expect(calls.map((c) => c.slug)).toEqual([
			"FACEBOOK_CREATE_PHOTO_POST",
			"FACEBOOK_GET_POST",
		]);
		const pub = readPost("2026-10-22-page-only").publishing;
		expect(pub.state).toBe("published");
		expect(pub.instagram).toBeUndefined();
		expect(pub.facebook.postId).toBe("111_222");
		// The fake FACEBOOK_GET_POST dates the post on 22/10 at 20h (Brasília time).
		const quota = await run("quota", PROJECT, "--at", "2026-10-22T21:00");
		expect(quota.stdout).toContain("1 publicação(ões) na janela de 24h");
		const removed = await run("remove", PROJECT, dir);
		expect(removed.stdout).not.toContain("Instagram");
		expect(readPost("2026-10-22-page-only").publishing.state).toBe("removed");
	});

	test("--facebook-only does not skip approval", async () => {
		const dir = createPost("2026-10-22-page-only-draft", {
			format: "post",
		});
		const r = await run("publish", PROJECT, dir, "--facebook-only");
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('"draft"');
		expect(calls).toEqual([]);
	});

	test("if the Page fails, the post stays approved and the error is recorded", async () => {
		pageFails = true;
		const dir = await createApproved("2026-10-22-page-only-fails", "post");
		const r = await run("publish", PROJECT, dir, "--facebook-only");
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("a Página não publicou");
		const pub = readPost("2026-10-22-page-only-fails").publishing;
		expect(pub.state).toBe("approved");
		expect(pub.facebook.error).toContain("sem permissão");
	});
});

describe("publishing flow", () => {
	test("an approved carousel goes to Instagram and the Page, and records media id and permalink", async () => {
		const dir = await createApproved("2026-10-22-e02-confraternizacao");
		const r = await run("publish", PROJECT, dir);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);

		expect(calls.map((c) => c.slug)).toEqual([
			"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
			"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
			"INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
			"INSTAGRAM_GET_IG_MEDIA",
			"FACEBOOK_CREATE_MULTI_PHOTO_POST",
			"FACEBOOK_GET_POST",
		]);
		const carousel = calls.find(
			(c) => c.slug === "INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
		);
		expect(carousel?.args.child_image_urls).toEqual([
			"https://pub.example.r2.dev/2026-10-22-e02-confraternizacao/final/01.jpg",
			"https://pub.example.r2.dev/2026-10-22-e02-confraternizacao/final/02.jpg",
		]);
		expect(String(carousel?.args.caption)).toContain("#partyshare");
		expect(carousel?.account).toBe("ca_instagram");
		const publishCall = calls.find(
			(c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
		);
		expect(publishCall?.args.creation_id).toBe("carousel1");
		const fb = calls.find((c) => c.slug === "FACEBOOK_CREATE_MULTI_PHOTO_POST");
		expect(fb?.account).toBe("ca_facebook");
		expect(String(fb?.args.message)).toContain("utm_source=facebook");

		const pub = readPost("2026-10-22-e02-confraternizacao").publishing;
		expect(pub.state).toBe("published");
		expect(pub.instagram.mediaId).toBe("1790000000001");
		expect(pub.instagram.permalink).toBe("https://www.instagram.com/p/TEST/");
		expect(pub.instagram.containers).toEqual(["c1", "c2"]);
		expect(pub.facebook).toMatchObject({
			postId: "111_222",
			permalink: "https://www.facebook.com/111/posts/222",
		});
		expect(pub.quota.meta).toEqual({ quota_usage: 0, quota_total: 100 });
	});

	test("a single post uses one container with caption and the single photo on the Page", async () => {
		const dir = await createApproved("2026-10-22-e06-vagas", "post");
		expect((await run("publish", PROJECT, dir)).code).toBe(0);
		expect(calls.map((c) => c.slug)).not.toContain(
			"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
		);
		const single = calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA");
		expect(single?.args.caption).toBeDefined();
		expect(calls.map((c) => c.slug)).toContain("FACEBOOK_CREATE_PHOTO_POST");
	});

	test("does not publish without approval", async () => {
		const dir = createPost("2026-10-22-no-approval");
		const r = await run("publish", PROJECT, dir);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain('"draft"');
		expect(calls).toEqual([]);
	});

	test("question carries the caption, images with absolute paths and the three options", async () => {
		const dir = createPost("2026-10-22-e02-confraternizacao");
		expect((await run("caption", PROJECT, dir)).code).toBe(0);
		const r = await run("question", PROJECT, dir);
		expect(r.code).toBe(0);
		const question = JSON.parse(r.stdout).questions[0];
		expect(question.options.map((o: { label: string }) => o.label)).toEqual([
			"Aprovar",
			"Pedir ajuste",
			"Descartar",
		]);
		// Instagram and the Page each get their own caption, labeled.
		expect(question.question).toContain(
			"Legenda do Instagram:\nA confraternização",
		);
		expect(question.question).toContain("Legenda da Página:\n");
		expect(question.question).toContain("para Instagram @test + Página Test?");
		expect(question.question).toContain(
			`![final/01.jpg](${join(dir, "final/01.jpg")})`,
		);
		expect(question.question).toContain(
			`![final/02.jpg](${join(dir, "final/02.jpg")})`,
		);
		expect(readPost("2026-10-22-e02-confraternizacao").publishing.state).toBe(
			"awaiting_approval",
		);
	});

	test("a caption outside the project's rules does not move forward", async () => {
		const dir = createPost("2026-10-22-bad-caption");
		writeFileSync(join(dir, "caption.txt"), "Teste grátis! #festa");
		const r = await run("caption", PROJECT, dir);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("forbidden-term");
		expect(r.stderr).toContain("forbidden-hashtag");
	});

	test("requesting changes needs a comment and goes back to draft in the next round", async () => {
		const dir = createPost("2026-10-22-changes");
		await run("caption", PROJECT, dir);
		await run("question", PROJECT, dir);
		expect((await run("decision", PROJECT, dir, "Pedir ajuste")).code).toBe(1);
		expect(
			(await run("decision", PROJECT, dir, "2", "--comment", "CTA mais curto"))
				.code,
		).toBe(0);
		expect((await run("redo", PROJECT, dir, "--caption-only")).code).toBe(0);
		const pub = readPost("2026-10-22-changes").publishing;
		expect(pub).toMatchObject({ state: "draft", round: 2 });
		expect(pub.approvals).toMatchObject([
			{ round: 1, decision: "request_changes", comment: "CTA mais curto" },
		]);
		await run("caption", PROJECT, dir);
		expect(
			JSON.parse((await run("question", PROJECT, dir)).stdout).questions[0]
				.question,
		).toContain("Ajuste pedido: CTA mais curto");
	});

	test("discarding archives without publishing", async () => {
		const dir = createPost("2026-10-22-discard");
		await run("caption", PROJECT, dir);
		await run("question", PROJECT, dir);
		expect((await run("decision", PROJECT, dir, "Descartar")).code).toBe(0);
		expect(readPost("2026-10-22-discard").publishing.state).toBe("discarded");
		expect((await run("publish", PROJECT, dir)).code).not.toBe(0);
	});

	test("refuses the project's fourth post in 24h, and pushes it to the next day", async () => {
		const hour = 3600_000;
		for (const [i, state] of [
			"published",
			"published",
			"scheduled",
		].entries()) {
			const when = new Date(Date.now() - (i + 1) * hour).toISOString();
			createPost(`2026-10-2${i}-previous-${i}`, {
				publishing:
					state === "published"
						? { state, instagram: { publishedAt: when } }
						: {
								state,
								scheduledFor: new Date(Date.now() + 2 * hour).toISOString(),
							},
			});
		}
		const dir = await createApproved("2026-10-22-fourth");
		const refused = await run("publish", PROJECT, dir);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("já tem 3 publicações");
		expect(calls).toEqual([]);

		expect((await run("publish", PROJECT, dir, "--reschedule")).code).toBe(0);
		const pub = readPost("2026-10-22-fourth").publishing;
		expect(pub.state).toBe("scheduled");
		expect(Date.parse(pub.scheduledFor)).toBeGreaterThan(
			Date.now() + 20 * hour,
		);
		expect(calls).toEqual([]);
	});

	test("posts of another project neither count nor can be published by this one", async () => {
		const other = join(
			ROOT,
			"projects",
			"partyshare",
			"posts",
			"does-not-exist",
		);
		const r = await run("publish", PROJECT, other);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`não é um post do projeto ${PROJECT}`);
	});

	test("respects Meta's content_publishing_limit", async () => {
		quotaUsage = 100;
		const dir = await createApproved("2026-10-22-meta-limit");
		const r = await run("publish", PROJECT, dir);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("100 de 100");
		expect(calls.map((c) => c.slug)).toEqual([
			"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		]);
	});

	test("remove deletes on the Page and marks the post", async () => {
		const dir = await createApproved("2026-10-22-remove", "post");
		await run("publish", PROJECT, dir);
		calls = [];
		expect((await run("remove", PROJECT, dir)).code).toBe(0);
		expect(calls).toMatchObject([
			{ slug: "FACEBOOK_DELETE_POST", args: { post_id: "111_222" } },
		]);
		expect(readPost("2026-10-22-remove").publishing.state).toBe("removed");
	});
});

describe("Composio call log", () => {
	test("each command that calls Composio records its calls, for usage to sum", async () => {
		const dir = await createApproved("2026-10-22-usage");
		expect(readComposioLog()).toEqual([]);
		expect((await run("publish", PROJECT, dir)).code).toBe(0);
		await run("connection", PROJECT);
		const [publish, connection] = readComposioLog();
		expect(publish).toMatchObject({
			command: "publish",
			post: "2026-10-22-usage",
			composioCalls: {
				total: 6,
				failed: 0,
				bySlug: {
					INSTAGRAM_CREATE_CAROUSEL_CONTAINER: 1,
					FACEBOOK_GET_POST: 1,
				},
			},
		});
		expect(connection).toMatchObject({
			command: "connection",
			composioCalls: { metaTools: { COMPOSIO_MANAGE_CONNECTIONS: 1 } },
		});
		expect(connection.composioCalls.total).toBe(calls.length - 6);
	});

	test("a command that stops halfway records the calls it already made", async () => {
		quotaUsage = 100;
		const dir = await createApproved("2026-10-22-usage-refused");
		expect((await run("publish", PROJECT, dir)).code).toBe(1);
		expect(readComposioLog()).toMatchObject([
			{ command: "publish", composioCalls: { total: 1 } },
		]);
	});

	test("what does not call Composio records nothing", async () => {
		const dir = await createApproved("2026-10-22-usage-none");
		await run("status", PROJECT, dir);
		expect(existsSync(COMPOSIO_LOG)).toBe(false);
	});
});

/** A post that went through caption, question and "Aprovar". */
async function createApproved(
	name: string,
	format: "post" | "carousel" = "carousel",
) {
	const dir = createPost(name, { format });
	for (const step of [
		["caption", PROJECT, dir],
		["question", PROJECT, dir],
		["decision", PROJECT, dir, "Aprovar"],
	]) {
		const r = await run(...step);
		if (r.code !== 0) throw new Error(`${step[0]}: ${r.stderr}`);
	}
	return dir;
}

describe("init", () => {
	const other = `test-init-${process.pid}`;
	const otherDir = join(ROOT, "projects", other);

	afterAll(() => rmSync(otherDir, { recursive: true, force: true }));

	test("creates publishing.json with every account null, and never overwrites it", async () => {
		// No folder and no campaign.md yet: the accounts come first, the campaign may arrive later.
		const first = await run("init", other);
		expect(first.code).toBe(0);
		expect(first.stderr).toContain("campaign.md");
		const config = JSON.parse(
			readFileSync(join(otherDir, "publishing.json"), "utf8"),
		);
		expect(config.instagram).toEqual({
			composioAccount: null,
			igUserId: null,
			username: null,
		});
		expect(config.facebook.pageId).toBeNull();
		expect(config.caption.ctas).toEqual([]);
		expect(first.stdout).toContain(`connection ${other} --save`);

		const second = await run("init", other);
		expect(second.code).toBe(1);
		expect(second.stderr).toContain("já existe");
	});

	test("a project without publishing.json points at init", async () => {
		const bare = join(ROOT, "projects", `${other}-bare`);
		mkdirSync(bare, { recursive: true });
		try {
			const r = await run("quota", `${other}-bare`);
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(`publishing.ts init ${other}-bare`);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

const MFLUX_PYTHON =
	process.env.MFLUX_PYTHON ??
	join(process.env.HOME ?? "", ".local/share/uv/tools/mflux/bin/python");
const ASSET = join(ROOT, "projects/exemplo-cline/assets/app-icon.png");

describe.if(existsSync(MFLUX_PYTHON))("draft with ready images", () => {
	const request = (name: string, images: Record<string, string>[]) => {
		const path = join(PROJECT_DIR, `${name}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				idea: "imagem da task",
				pillar: "2. Confraternização",
				format: images.length > 1 ? "carousel" : "post",
				count: images.length,
				slug: name,
				date: "2026-10-30",
				images,
			}),
		);
		return path;
	};

	test("a local file becomes final/01.jpg at the feed size and the post enters the flow", async () => {
		const r = await run(
			"draft",
			PROJECT,
			request("from-file", [{ source: ASSET }]),
		);
		expect(r.code).toBe(0);
		const post = readPost("2026-10-30-from-file");
		expect(post.origin).toBe("import");
		expect(post.review.chosen).toEqual([
			expect.objectContaining({ n: "01", file: "final/01.jpg", source: ASSET }),
		]);
		expect(post.publishing.state).toBe("draft");
		expect(post.images[0].cropped).toBe(true);
		const jpeg = readFileSync(join(POSTS, "2026-10-30-from-file/final/01.jpg"));
		expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
	});

	test("a URL is downloaded and imported the same way", async () => {
		const images = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(Bun.file(ASSET), {
					headers: { "content-type": "image/png" },
				}),
		});
		try {
			const url = `http://localhost:${images.port}/photo.png`;
			const r = await run(
				"draft",
				PROJECT,
				request("from-url", [{ source: url }]),
			);
			expect(r.code).toBe(0);
			expect(readPost("2026-10-30-from-url").review.chosen[0].source).toBe(url);
		} finally {
			images.stop(true);
		}
	});

	test("a request mixing scene and source is refused before anything runs", async () => {
		const r = await run(
			"draft",
			PROJECT,
			request("mixed", [{ source: ASSET }, { scene: "a party" }]),
		);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("mistura");
		expect(existsSync(join(POSTS, "2026-10-30-mixed"))).toBe(false);
	});
});

describe("a project whose Instagram is not connected", () => {
	const file = join(PROJECT_DIR, "publishing.json");
	let before = "";
	beforeEach(() => {
		before = readFileSync(file, "utf8");
		const config = JSON.parse(before);
		config.instagram = {
			composioAccount: null,
			igUserId: null,
			username: null,
		};
		writeFileSync(file, JSON.stringify(config));
	});
	afterEach(() => writeFileSync(file, before));

	test("caption does not need caption.txt, and the question names only the Page", async () => {
		const dir = createPost("2026-10-23-page-caption", { format: "post" });
		rmSync(join(dir, "caption.txt"));
		const checked = await run("caption", PROJECT, dir);
		expect(checked.code).toBe(0);
		expect(checked.stdout).toContain("caption.txt dispensado");
		const r = await run("question", PROJECT, dir);
		expect(r.code).toBe(0);
		const text = JSON.parse(r.stdout).questions[0].question as string;
		expect(text).toContain("para Página Test?");
		expect(text).not.toContain("Instagram @");
		expect(text).toContain(
			"Legenda:\nA confraternização acontece uma vez. Solicitar",
		);
		expect(text).toContain("vai só para a Página");
	});

	test("an approved Page-only post publishes with --facebook-only without an Instagram caption", async () => {
		const dir = createPost("2026-10-23-page-publish", { format: "post" });
		rmSync(join(dir, "caption.txt"));
		for (const step of [
			["caption", PROJECT, dir],
			["question", PROJECT, dir],
			["decision", PROJECT, dir, "approve"],
		]) {
			const r = await run(...step);
			expect(r.code).toBe(0);
		}
		const r = await run("publish", PROJECT, dir, "--facebook-only");
		expect(r.code).toBe(0);
		expect(readPost("2026-10-23-page-publish").publishing.state).toBe(
			"published",
		);
	});
});

describe("connection picks the Page it is told to", () => {
	const file = join(PROJECT_DIR, "publishing.json");
	let before = "";
	beforeEach(() => {
		before = readFileSync(file, "utf8");
		const config = JSON.parse(before);
		config.facebook.pageId = null;
		writeFileSync(file, JSON.stringify(config));
	});
	afterEach(() => writeFileSync(file, before));

	test("--page wins over the Page linked to the Instagram Composio returned", async () => {
		const r = await run("connection", PROJECT, "--save", "--page", "il Burger");
		expect(r.code).toBe(0);
		const config = JSON.parse(readFileSync(file, "utf8"));
		expect(config.facebook.pageId).toBe("999");
	});

	test("--page-only saves the Page and leaves instagram as it was", async () => {
		const r = await run(
			"connection",
			PROJECT,
			"--save",
			"--page",
			"il Burger",
			"--page-only",
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("não gravado (--page-only)");
		const config = JSON.parse(readFileSync(file, "utf8"));
		expect(config.facebook.pageId).toBe("999");
		expect(config.instagram).toEqual(JSON.parse(before).instagram);
	});
});
