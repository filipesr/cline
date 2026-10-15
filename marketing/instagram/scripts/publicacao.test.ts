/**
 * O fluxo de ponta a ponta contra um Composio falso: pergunta, decisão, teto do projeto,
 * containers do carrossel, publicação, Página do Facebook e o registro no post.json. As
 * imagens e a hospedagem têm os seus próprios scripts; aqui o post já chega com elas.
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
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const RAIZ = resolve(import.meta.dir, "..");
const PROJETO = `teste-fluxo-${process.pid}`;
const PASTA_PROJETO = join(RAIZ, "projects", PROJETO);
const POSTS = join(PASTA_PROJETO, "posts");

type Chamada = {
	slug: string;
	conta: string;
	argumentos: Record<string, unknown>;
};
let chamadas: Chamada[] = [];
let servidor: ReturnType<typeof Bun.serve>;
let quotaUsage = 0;

// Assíncrono de propósito: um spawnSync travaria o servidor falso, que roda neste processo.
async function rodar(...args: string[]) {
	const r = Bun.spawn(
		["bun", join(import.meta.dir, "publicacao.ts"), ...args],
		{
			cwd: RAIZ,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				COMPOSIO_CONSUMER_API_KEY: "ck_teste",
				COMPOSIO_MCP_URL: `http://localhost:${servidor.port}/mcp`,
			},
		},
	);
	const [saida, erro, codigo] = await Promise.all([
		new Response(r.stdout).text(),
		new Response(r.stderr).text(),
		r.exited,
	]);
	return { codigo, saida, erro };
}

function lerPost(nome: string) {
	return JSON.parse(readFileSync(join(POSTS, nome, "post.json"), "utf8"));
}

function criarPost(
	nome: string,
	opcoes: {
		formato?: "post" | "carrossel";
		publicacao?: Record<string, unknown>;
	} = {},
) {
	const formato = opcoes.formato ?? "carrossel";
	const n = formato === "carrossel" ? 2 : 1;
	const pasta = join(POSTS, nome);
	mkdirSync(join(pasta, "final"), { recursive: true });
	const escolhidas = Array.from({ length: n }, (_, i) => {
		const arquivo = `final/0${i + 1}.jpg`;
		writeFileSync(join(pasta, arquivo), "jpeg");
		return { n: `0${i + 1}`, arquivo };
	});
	writeFileSync(
		join(pasta, "post.json"),
		JSON.stringify({
			projeto: PROJETO,
			slug: nome.slice(11),
			data: nome.slice(0, 10),
			formato,
			quantidade: n,
			revisao: { escolhidas },
			publicacao: {
				estado: "rascunho",
				rodada: 1,
				pedido: {},
				aprovacoes: [],
				historico: [],
				midia: escolhidas.map((e) => ({
					arquivo: e.arquivo,
					url: `https://pub.example.r2.dev/${nome}/${e.arquivo}`,
					enviadoEm: new Date().toISOString(),
				})),
				...opcoes.publicacao,
			},
		}),
	);
	writeFileSync(
		join(pasta, "legenda.txt"),
		"A confraternização acontece uma vez.\n\nSolicitar proposta corporativa.\n\n#partyshare #rh #endomarketing",
	);
	writeFileSync(
		join(pasta, "legenda-facebook.txt"),
		"A confraternização acontece uma vez. Solicitar proposta corporativa: https://www.partyshare.me/business?utm_source=facebook&utm_content=e02\n\n#partyshare #rh",
	);
	return pasta;
}

beforeAll(() => {
	servidor = Bun.serve({
		port: 0,
		// Fala o MCP do Composio: initialize, tools/list e tools/call de
		// COMPOSIO_MULTI_EXECUTE_TOOL. Responde em SSE, como o servidor real.
		async fetch(req) {
			if (req.headers.get("x-consumer-api-key") !== "ck_teste") {
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
							"mcp-session-id": "sessao-1",
						},
					},
				);
			if (rpc.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			if (rpc.method === "initialize") {
				return sse({ protocolVersion: "2025-06-18", capabilities: {} });
			}
			if (req.headers.get("mcp-session-id") !== "sessao-1") {
				return new Response("sem sessão", { status: 400 });
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
							inputSchema: { properties: { toolkits: {}, action: {} } },
						},
					],
				});
			}
			const texto = (corpo: unknown) =>
				sse({ content: [{ type: "text", text: JSON.stringify(corpo) }] });
			if (rpc.params?.name === "COMPOSIO_MANAGE_CONNECTIONS") {
				return texto({
					successful: true,
					data: { summary: { active_connections: 2 } },
				});
			}
			const [item] = rpc.params?.arguments?.tools as {
				tool_slug: string;
				arguments: Record<string, unknown>;
				account?: string;
			}[];
			const slug = item.tool_slug;
			chamadas.push({
				slug,
				conta: item.account ?? "",
				argumentos: item.arguments,
			});
			const ok = (data: unknown) =>
				texto({
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
							id: "carrossel1",
							children: [{ id: "c1" }, { id: "c2" }],
						}),
					);
				case "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH":
					return ok({ id: "1790000000001" });
				case "INSTAGRAM_GET_IG_MEDIA":
					return ok({
						id: "1790000000001",
						permalink: "https://www.instagram.com/p/TESTE/",
						timestamp: new Date().toISOString(),
						caption:
							"A confraternização acontece uma vez.\n\nSolicitar proposta corporativa.\n\n#partyshare #rh #endomarketing",
					});
				case "FACEBOOK_CREATE_MULTI_PHOTO_POST":
				case "FACEBOOK_CREATE_PHOTO_POST":
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
					return texto({
						successful: true,
						data: {
							results: [
								{ index: 0, tool_slug: slug, error: `slug inesperado ${slug}` },
							],
						},
					});
			}
		},
	});
	mkdirSync(PASTA_PROJETO, { recursive: true });
	const config = JSON.parse(
		readFileSync(join(RAIZ, "projects/partyshare/publicacao.json"), "utf8"),
	);
	config.instagram = {
		contaComposio: "ca_instagram",
		igUserId: "17841400000000000",
		usuario: "teste",
	};
	config.facebook = {
		espelhar: true,
		contaComposio: "ca_facebook",
		pageId: "111",
		nome: "Teste",
	};
	writeFileSync(join(PASTA_PROJETO, "publicacao.json"), JSON.stringify(config));
	cpSync(
		join(RAIZ, "projects/partyshare/campaign.md"),
		join(PASTA_PROJETO, "campaign.md"),
	);
});

afterAll(() => {
	servidor.stop(true);
	rmSync(PASTA_PROJETO, { recursive: true, force: true });
});

beforeEach(() => {
	chamadas = [];
	quotaUsage = 0;
	rmSync(POSTS, { recursive: true, force: true });
});

setDefaultTimeout(30_000);

describe("fluxo de publicação", () => {
	test("carrossel aprovado vai ao Instagram e à Página, e registra media id e permalink", async () => {
		const pasta = await criarAprovado("2026-10-22-e02-confraternizacao");
		const r = await rodar("publicar", PROJETO, pasta);
		expect(r.erro).toBe("");
		expect(r.codigo).toBe(0);

		expect(chamadas.map((c) => c.slug)).toEqual([
			"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
			"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
			"INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
			"INSTAGRAM_GET_IG_MEDIA",
			"FACEBOOK_CREATE_MULTI_PHOTO_POST",
			"FACEBOOK_GET_POST",
		]);
		const carrossel = chamadas.find(
			(c) => c.slug === "INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
		);
		expect(carrossel?.argumentos.child_image_urls).toEqual([
			"https://pub.example.r2.dev/2026-10-22-e02-confraternizacao/final/01.jpg",
			"https://pub.example.r2.dev/2026-10-22-e02-confraternizacao/final/02.jpg",
		]);
		expect(String(carrossel?.argumentos.caption)).toContain("#partyshare");
		expect(carrossel?.conta).toBe("ca_instagram");
		const publish = chamadas.find(
			(c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
		);
		expect(publish?.argumentos.creation_id).toBe("carrossel1");
		const fb = chamadas.find(
			(c) => c.slug === "FACEBOOK_CREATE_MULTI_PHOTO_POST",
		);
		expect(fb?.conta).toBe("ca_facebook");
		expect(String(fb?.argumentos.message)).toContain("utm_source=facebook");

		const pub = lerPost("2026-10-22-e02-confraternizacao").publicacao;
		expect(pub.estado).toBe("publicado");
		expect(pub.instagram.mediaId).toBe("1790000000001");
		expect(pub.instagram.permalink).toBe("https://www.instagram.com/p/TESTE/");
		expect(pub.instagram.containers).toEqual(["c1", "c2"]);
		expect(pub.facebook).toMatchObject({
			postId: "111_222",
			permalink: "https://www.facebook.com/111/posts/222",
		});
		expect(pub.cota.meta).toEqual({ quota_usage: 0, quota_total: 100 });
	});

	test("post único usa um container com legenda e a foto única na Página", async () => {
		const pasta = await criarAprovado("2026-10-22-e06-vagas", "post");
		expect((await rodar("publicar", PROJETO, pasta)).codigo).toBe(0);
		expect(chamadas.map((c) => c.slug)).not.toContain(
			"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
		);
		const unico = chamadas.find(
			(c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA",
		);
		expect(unico?.argumentos.caption).toBeDefined();
		expect(chamadas.map((c) => c.slug)).toContain("FACEBOOK_CREATE_PHOTO_POST");
	});

	test("não publica sem aprovação", async () => {
		const pasta = criarPost("2026-10-22-sem-aprovacao");
		const r = await rodar("publicar", PROJETO, pasta);
		expect(r.codigo).not.toBe(0);
		expect(r.erro).toContain('"rascunho"');
		expect(chamadas).toEqual([]);
	});

	test("pergunta leva legenda, imagens com caminho absoluto e as três opções", async () => {
		const pasta = criarPost("2026-10-22-e02-confraternizacao");
		expect((await rodar("legenda", PROJETO, pasta)).codigo).toBe(0);
		const r = await rodar("pergunta", PROJETO, pasta);
		expect(r.codigo).toBe(0);
		const pergunta = JSON.parse(r.saida).questions[0];
		expect(pergunta.options.map((o: { label: string }) => o.label)).toEqual([
			"Aprovar",
			"Pedir ajuste",
			"Descartar",
		]);
		expect(pergunta.question).toContain("Legenda:\nA confraternização");
		expect(pergunta.question).toContain(
			`![final/01.jpg](${join(pasta, "final/01.jpg")})`,
		);
		expect(pergunta.question).toContain(
			`![final/02.jpg](${join(pasta, "final/02.jpg")})`,
		);
		expect(lerPost("2026-10-22-e02-confraternizacao").publicacao.estado).toBe(
			"aguardando_aprovacao",
		);
	});

	test("legenda fora das regras do projeto não avança", async () => {
		const pasta = criarPost("2026-10-22-legenda-ruim");
		writeFileSync(join(pasta, "legenda.txt"), "Teste grátis! #festa");
		const r = await rodar("legenda", PROJETO, pasta);
		expect(r.codigo).toBe(1);
		expect(r.erro).toContain("termo-proibido");
		expect(r.erro).toContain("hashtag-proibida");
	});

	test("pedir ajuste exige comentário e volta ao rascunho na rodada seguinte", async () => {
		const pasta = criarPost("2026-10-22-ajuste");
		await rodar("legenda", PROJETO, pasta);
		await rodar("pergunta", PROJETO, pasta);
		expect(
			(await rodar("decisao", PROJETO, pasta, "Pedir ajuste")).codigo,
		).toBe(1);
		expect(
			(
				await rodar(
					"decisao",
					PROJETO,
					pasta,
					"2",
					"--comentario",
					"CTA mais curto",
				)
			).codigo,
		).toBe(0);
		expect(
			(await rodar("refazer", PROJETO, pasta, "--so-legenda")).codigo,
		).toBe(0);
		const pub = lerPost("2026-10-22-ajuste").publicacao;
		expect(pub).toMatchObject({ estado: "rascunho", rodada: 2 });
		expect(pub.aprovacoes).toMatchObject([
			{ rodada: 1, decisao: "ajuste", comentario: "CTA mais curto" },
		]);
		await rodar("legenda", PROJETO, pasta);
		expect(
			JSON.parse((await rodar("pergunta", PROJETO, pasta)).saida).questions[0]
				.question,
		).toContain("Ajuste pedido: CTA mais curto");
	});

	test("descartar arquiva sem publicar", async () => {
		const pasta = criarPost("2026-10-22-descarte");
		await rodar("legenda", PROJETO, pasta);
		await rodar("pergunta", PROJETO, pasta);
		expect((await rodar("decisao", PROJETO, pasta, "Descartar")).codigo).toBe(
			0,
		);
		expect(lerPost("2026-10-22-descarte").publicacao.estado).toBe("descartado");
		expect((await rodar("publicar", PROJETO, pasta)).codigo).not.toBe(0);
	});

	test("recusa a quarta publicação do projeto em 24h, e empurra para o dia seguinte", async () => {
		const hora = 3600_000;
		for (const [i, estado] of [
			"publicado",
			"publicado",
			"agendado",
		].entries()) {
			const quando = new Date(Date.now() - (i + 1) * hora).toISOString();
			criarPost(`2026-10-2${i}-anterior-${i}`, {
				publicacao:
					estado === "publicado"
						? { estado, instagram: { publicadoEm: quando } }
						: {
								estado,
								agendadoPara: new Date(Date.now() + 2 * hora).toISOString(),
							},
			});
		}
		const pasta = await criarAprovado("2026-10-22-quarto");
		const recusado = await rodar("publicar", PROJETO, pasta);
		expect(recusado.codigo).toBe(1);
		expect(recusado.erro).toContain("já tem 3 publicações");
		expect(chamadas).toEqual([]);

		expect((await rodar("publicar", PROJETO, pasta, "--empurrar")).codigo).toBe(
			0,
		);
		const pub = lerPost("2026-10-22-quarto").publicacao;
		expect(pub.estado).toBe("agendado");
		expect(Date.parse(pub.agendadoPara)).toBeGreaterThan(
			Date.now() + 20 * hora,
		);
		expect(chamadas).toEqual([]);
	});

	test("posts de outro projeto não contam nem podem ser publicados por este", async () => {
		const outro = join(RAIZ, "projects", "partyshare", "posts", "nao-existe");
		const r = await rodar("publicar", PROJETO, outro);
		expect(r.codigo).toBe(1);
		expect(r.erro).toContain(`não é um post do projeto ${PROJETO}`);
	});

	test("respeita o content_publishing_limit da Meta", async () => {
		quotaUsage = 100;
		const pasta = await criarAprovado("2026-10-22-limite-meta");
		const r = await rodar("publicar", PROJETO, pasta);
		expect(r.codigo).toBe(1);
		expect(r.erro).toContain("100 de 100");
		expect(chamadas.map((c) => c.slug)).toEqual([
			"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		]);
	});

	test("remover apaga na Página e marca o post", async () => {
		const pasta = await criarAprovado("2026-10-22-remover", "post");
		await rodar("publicar", PROJETO, pasta);
		chamadas = [];
		expect((await rodar("remover", PROJETO, pasta)).codigo).toBe(0);
		expect(chamadas).toMatchObject([
			{ slug: "FACEBOOK_DELETE_POST", argumentos: { post_id: "111_222" } },
		]);
		expect(lerPost("2026-10-22-remover").publicacao.estado).toBe("removido");
	});
});

/** Um post que passou por legenda, pergunta e "Aprovar". */
async function criarAprovado(
	nome: string,
	formato: "post" | "carrossel" = "carrossel",
) {
	const pasta = criarPost(nome, { formato });
	for (const passo of [
		["legenda", PROJETO, pasta],
		["pergunta", PROJETO, pasta],
		["decisao", PROJETO, pasta, "Aprovar"],
	]) {
		const r = await rodar(...passo);
		if (r.codigo !== 0) throw new Error(`${passo[0]}: ${r.erro}`);
	}
	return pasta;
}
