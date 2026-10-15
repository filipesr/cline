#!/usr/bin/env bun
/**
 * Fluxo de publicação: de um item do calendário do projeto até o post no ar.
 *
 *   bun scripts/publicacao.ts conexao   <projeto> [--salvar] [--pagina "<nome>"]
 *   bun scripts/publicacao.ts calendario <projeto> [--data AAAA-MM-DD]
 *   bun scripts/publicacao.ts rascunho  <projeto> <pedido.json>
 *   bun scripts/publicacao.ts legenda   <projeto> <pasta-do-post>
 *   bun scripts/publicacao.ts hospedar  <projeto> <pasta-do-post>
 *   bun scripts/publicacao.ts pergunta  <projeto> <pasta-do-post>
 *   bun scripts/publicacao.ts decisao   <projeto> <pasta-do-post> <resposta> [--comentario "..."]
 *   bun scripts/publicacao.ts refazer   <projeto> <pasta-do-post> [--pedido novo.json] [--so-legenda]
 *   bun scripts/publicacao.ts cota      <projeto> [--em AAAA-MM-DDTHH:MM]
 *   bun scripts/publicacao.ts publicar  <projeto> <pasta-do-post> [--em AAAA-MM-DDTHH:MM] [--empurrar] [--so-facebook]
 *   bun scripts/publicacao.ts remover   <projeto> <pasta-do-post>
 *   bun scripts/publicacao.ts estado    <projeto> <pasta-do-post>
 *
 * Tudo parte do projeto selecionado: a configuração (projects/<projeto>/publicacao.json), as
 * regras de legenda, as contas conectadas e o histórico que conta para o teto diário são dele, e
 * uma pasta de post fora de projects/<projeto>/posts/ é recusada. As chaves vêm de
 * ~/.config/cline-marketing/instagram.env (ver segredos.ts).
 */
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { acharCampo, type Composio, criarComposio } from "./composio";
import {
	analisarLegenda,
	aplicarDecisao,
	cabeNaJanela,
	type Estado,
	instanteLocal,
	lerDecisao,
	proximoDiaLivre,
	type RegrasLegenda,
	semAcento,
} from "./publicacao-regras";
import { carregarSegredos } from "./segredos";

carregarSegredos();

const RAIZ = resolve(import.meta.dir, "..");
const IMAGENS = join(import.meta.dir, "imagens.ts");
const UPLOAD = join(import.meta.dir, "upload-image.ts");
const OPCOES_APROVACAO = ["Aprovar", "Pedir ajuste", "Descartar"] as const;

type Config = {
	fusoHorario: string;
	/** Offset fixo do fuso, para ler "AAAA-MM-DDTHH:MM" (o Brasil não tem horário de verão). */
	offset: string;
	limitePorDia: number;
	instagram: {
		contaComposio?: string | null;
		igUserId?: string | null;
		usuario?: string | null;
	};
	facebook?: {
		espelhar: boolean;
		contaComposio?: string | null;
		pageId?: string | null;
		nome?: string | null;
	};
	legenda: RegrasLegenda;
	legendaFacebook?: RegrasLegenda;
};

type Midia = { arquivo: string; url: string; enviadoEm: string };

type Publicacao = {
	estado: Estado;
	rodada: number;
	pedido: Record<string, unknown>;
	legenda?: {
		arquivo: string;
		texto: string;
		hashtags: string[];
		cta?: string;
		conferidaEm: string;
	};
	legendaFacebook?: { arquivo: string; texto: string; conferidaEm: string };
	midia?: Midia[];
	pergunta?: { feitaEm: string; rodada: number };
	aprovacoes: {
		rodada: number;
		decisao: string;
		comentario?: string;
		em: string;
	}[];
	agendadoPara?: string;
	cota?: Record<string, unknown>;
	instagram?: {
		igUserId: string;
		containers: string[];
		creationId: string;
		mediaId?: string;
		permalink?: string;
		publicadoEm?: string;
		legendaPublicada?: string;
	};
	facebook?: {
		pageId: string;
		postId?: string;
		permalink?: string;
		publicadoEm?: string;
		erro?: string;
	};
	removidoEm?: string;
	historico: { em: string; evento: string; detalhe?: string }[];
};

type Post = {
	projeto: string;
	slug: string;
	data: string;
	formato: "post" | "carrossel" | "story";
	quantidade: number;
	revisao: null | { escolhidas: { n: string; arquivo: string }[] };
	publicacao?: Publicacao;
	[chave: string]: unknown;
};

function falhar(mensagem: string): never {
	console.error(`erro: ${mensagem}`);
	process.exit(1);
}

function lerJson<T>(caminho: string): T {
	if (!existsSync(caminho)) falhar(`arquivo não encontrado: ${caminho}`);
	return JSON.parse(readFileSync(caminho, "utf8")) as T;
}

function salvarJson(caminho: string, valor: unknown) {
	writeFileSync(caminho, `${JSON.stringify(valor, null, "\t")}\n`);
}

const agora = () => new Date().toISOString();
const rel = (caminho: string) => relative(process.cwd(), caminho) || ".";

function pastaDoProjeto(projeto: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(projeto))
		falhar(`nome de projeto inválido: ${projeto}`);
	const pasta = join(RAIZ, "projects", projeto);
	if (!existsSync(pasta)) falhar(`projeto não existe: ${rel(pasta)}`);
	return pasta;
}

function lerConfig(projeto: string): Config {
	const caminho = join(pastaDoProjeto(projeto), "publicacao.json");
	if (!existsSync(caminho)) {
		falhar(
			`${rel(caminho)} não existe; copie o de outro projeto e ajuste as regras deste`,
		);
	}
	return lerJson<Config>(caminho);
}

function salvarConfig(projeto: string, config: Config) {
	salvarJson(join(pastaDoProjeto(projeto), "publicacao.json"), config);
}

/** Abre um post do projeto. Uma pasta de outro projeto é recusada, mesmo que exista. */
function abrirPost(projeto: string, pastaPost: string) {
	const posts = join(pastaDoProjeto(projeto), "posts");
	const pasta = resolve(pastaPost);
	if (!pasta.startsWith(`${posts}/`)) {
		falhar(
			`${rel(pasta)} não é um post do projeto ${projeto} (${rel(posts)}/<data>-<slug>)`,
		);
	}
	const caminho = join(pasta, "post.json");
	const post = lerJson<Post>(caminho);
	if (post.projeto !== projeto)
		falhar(`${rel(caminho)} é do projeto ${post.projeto}`);
	return {
		pasta,
		post,
		salvar: () => salvarJson(caminho, post),
	};
}

function publicacaoDe(post: Post): Publicacao {
	if (!post.publicacao) {
		falhar(
			`o post ${post.slug} não entrou no fluxo; crie com "publicacao.ts rascunho"`,
		);
	}
	return post.publicacao;
}

function registrar(pub: Publicacao, evento: string, detalhe?: string) {
	pub.historico.push({ em: agora(), evento, ...(detalhe ? { detalhe } : {}) });
}

function exigirEstado(pub: Publicacao, ...aceitos: Estado[]) {
	if (!aceitos.includes(pub.estado)) {
		falhar(
			`o post está em "${pub.estado}"; este passo exige ${aceitos.map((e) => `"${e}"`).join(" ou ")}`,
		);
	}
}

function rodar(args: string[], opcoes?: { capturar?: boolean }) {
	const r = Bun.spawnSync(["bun", ...args], {
		cwd: RAIZ,
		stdout: opcoes?.capturar ? "pipe" : "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (r.exitCode !== 0)
		falhar(
			`"bun ${args.map((a) => relative(RAIZ, a) || a).join(" ")}" saiu com ${r.exitCode}`,
		);
	return opcoes?.capturar ? (r.stdout?.toString() ?? "").trim() : "";
}

// ---------------------------------------------------------------------------------------------
// Conexão

/**
 * Confere o que o projeto vai usar: as conexões ativas no Composio, a conta do Instagram
 * (@, tipo, ig_user_id), o limite da Meta e a Página. Há mais de uma Página na conta, então a
 * do projeto é a já fixada, a ligada ao Instagram ou a que `--pagina` nomear; nunca um palpite.
 */
async function conexao(
	projeto: string,
	opcoes: { salvar: boolean; pagina?: string },
) {
	const config = lerConfig(projeto);
	const composio = criarComposio();
	const resumo = await composio.conexoes(["instagram", "facebook"]);
	console.log(
		`Conexões: ${JSON.stringify(acharCampo(resumo, "summary") ?? resumo).slice(0, 600)}`,
	);

	const contaIg = config.instagram.contaComposio;
	const info = await composio.executar(
		"INSTAGRAM_GET_USER_INFO",
		{
			ig_user_id: config.instagram.igUserId ?? "me",
			fields:
				"id,user_id,username,name,account_type,media_count,followers_count",
		},
		contaIg,
	);
	const igUserId = String(acharCampo(info, "id") ?? "");
	const usuario = String(acharCampo(info, "username") ?? "");
	const tipo = acharCampo(info, "account_type");
	if (!igUserId)
		falhar(
			`INSTAGRAM_GET_USER_INFO não devolveu id: ${JSON.stringify(info).slice(0, 400)}`,
		);
	console.log(`Instagram: @${usuario} · id ${igUserId} · tipo ${tipo ?? "?"}`);
	const limite = await composio.executar(
		"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		{ ig_user_id: igUserId, fields: "quota_usage,config" },
		contaIg,
	);
	console.log(
		`Limite da Meta: ${acharCampo(limite, "quota_usage") ?? "?"} de ${acharCampo(limite, "quota_total") ?? "?"} em 24h`,
	);

	const paginas = await composio.executar(
		"FACEBOOK_LIST_MANAGED_PAGES",
		{ fields: "id,name,tasks,instagram_business_account", limit: 50 },
		config.facebook?.contaComposio,
	);
	const lista = acharCampo(paginas, "data") ?? paginas;
	const itens = (Array.isArray(lista) ? lista : []) as Record<
		string,
		unknown
	>[];
	const ligadaDe = (p: Record<string, unknown>) =>
		(p.instagram_business_account as { id?: string } | undefined)?.id;
	for (const p of itens) {
		console.log(
			`Página: ${p.name} · id ${p.id}${ligadaDe(p) ? ` · ligada ao IG ${ligadaDe(p)}` : ""}`,
		);
	}
	const escolhida =
		itens.find((p) => String(p.id) === config.facebook?.pageId) ??
		itens.find((p) => ligadaDe(p) === igUserId) ??
		(opcoes.pagina
			? itens.find(
					(p) =>
						semAcento(String(p.name ?? "")) ===
						semAcento(opcoes.pagina as string),
				)
			: undefined);
	if (opcoes.pagina && !escolhida)
		falhar(`nenhuma Página se chama "${opcoes.pagina}"`);
	console.log(
		escolhida
			? `Página do projeto: ${escolhida.name} (${escolhida.id})`
			: 'Página do projeto: nenhuma fixada; use --pagina "<nome>" com --salvar',
	);

	if (opcoes.salvar) {
		config.instagram = { ...config.instagram, igUserId, usuario };
		if (escolhida) {
			config.facebook = {
				espelhar: config.facebook?.espelhar ?? true,
				contaComposio: config.facebook?.contaComposio ?? null,
				pageId: String(escolhida.id),
				nome: String(escolhida.name ?? ""),
			};
		}
		salvarConfig(projeto, config);
		console.log(
			`Salvo em ${rel(join(pastaDoProjeto(projeto), "publicacao.json"))}`,
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Calendário

const MESES = [
	"jan",
	"fev",
	"mar",
	"abr",
	"mai",
	"jun",
	"jul",
	"ago",
	"set",
	"out",
	"nov",
	"dez",
];

/** Linhas da tabela de calendário da campanha do projeto, com a data já em AAAA-MM-DD. */
function lerCalendario(projeto: string, ano: number) {
	const campanha = readFileSync(
		join(pastaDoProjeto(projeto), "campaign.md"),
		"utf8",
	).split("\n");
	const inicio = campanha.findIndex((l) =>
		/^#{1,6}\s+(\d+\.\s*)?calend[áa]rio/i.test(l),
	);
	if (inicio < 0)
		falhar(`projects/${projeto}/campaign.md não tem a seção de calendário`);
	const linhas = campanha.slice(inicio + 1);
	const fim = linhas.findIndex((l) => /^#{1,2}\s/.test(l));
	const tabela = (fim < 0 ? linhas : linhas.slice(0, fim)).filter((l) =>
		l.startsWith("|"),
	);
	const cabecalho =
		tabela[0]
			?.split("|")
			.slice(1, -1)
			.map((c) => c.trim().toLowerCase()) ?? [];
	return tabela.slice(2).flatMap((linha) => {
		const celulas = linha
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		const registro = Object.fromEntries(
			cabecalho.map((c, i) => [c, celulas[i] ?? ""]),
		);
		const m = (registro.data ?? "").match(/(\d{1,2})\/([a-zç]{3})/i);
		const mes = m ? MESES.indexOf(m[2].toLowerCase()) : -1;
		if (!m || mes < 0) return [];
		const data = `${ano}-${String(mes + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
		const codigo = (registro.ideia ?? "").match(/\*\*(E\d+)/)?.[1];
		return [
			{ ...registro, dia: registro.data, data, ...(codigo ? { codigo } : {}) },
		];
	});
}

// ---------------------------------------------------------------------------------------------
// Rascunho

function lerPedido(caminho: string) {
	const pedido = lerJson<Record<string, unknown>>(resolve(caminho));
	if (pedido.formato === "story") {
		falhar("stories ficam fora desta fase: o fluxo publica post e carrossel");
	}
	if (typeof pedido.slug !== "string" || typeof pedido.data !== "string") {
		falhar(
			"o pedido precisa de `slug` e `data` (AAAA-MM-DD), para a pasta do post ser previsível",
		);
	}
	return pedido;
}

function pastaDoPedido(projeto: string, pedido: Record<string, unknown>) {
	return join(
		pastaDoProjeto(projeto),
		"posts",
		`${pedido.data}-${pedido.slug}`,
	);
}

/** Gera as imagens pelo motor do projeto (scripts/imagens.ts) e põe o post no fluxo. */
function rascunho(projeto: string, arquivoPedido: string) {
	const pedido = lerPedido(arquivoPedido);
	const pasta = pastaDoPedido(projeto, pedido);
	if (existsSync(join(pasta, "post.json"))) {
		falhar(`${rel(pasta)} já existe; para refazer use "publicacao.ts refazer"`);
	}
	if (!existsSync(IMAGENS))
		falhar(`motor de imagens não encontrado: ${rel(IMAGENS)}`);
	rodar([IMAGENS, "gerar", projeto, resolve(arquivoPedido)]);
	const { post, salvar } = abrirPost(projeto, pasta);
	post.publicacao = {
		estado: "rascunho",
		rodada: 1,
		pedido,
		aprovacoes: [],
		historico: [],
	};
	registrar(post.publicacao, "rascunho", "rodada 1");
	salvar();
	console.log(
		`\nRascunho em ${rel(pasta)}. Próximo: revisar e escolher as variações (imagens.ts revisar/escolher), escrever legenda.txt.`,
	);
}

/**
 * Pedido de ajuste: refaz as imagens (com o pedido novo, se o comentário mudou a cena) ou só
 * a legenda, guardando o que o fluxo já sabe. O motor de imagens apaga a pasta ao refazer,
 * então o estado do fluxo é guardado antes e devolvido depois.
 */
function refazer(
	projeto: string,
	pastaPost: string,
	opcoes: { pedido?: string; soLegenda: boolean },
) {
	const { pasta, post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	exigirEstado(pub, "ajuste");
	const anterior = { ...pub };
	if (!opcoes.soLegenda) {
		const pedido = opcoes.pedido ? lerPedido(opcoes.pedido) : pub.pedido;
		if (`${pedido.data}-${pedido.slug}` !== basename(pasta)) {
			falhar(
				`o pedido novo aponta para ${pedido.data}-${pedido.slug}; mantenha data e slug de ${basename(pasta)}`,
			);
		}
		const temporario = join(
			mkdtempSync(join(tmpdir(), "publicacao-")),
			"pedido.json",
		);
		salvarJson(temporario, pedido);
		rodar([IMAGENS, "gerar", projeto, temporario, "--forcar"]);
		const novo = abrirPost(projeto, pasta);
		novo.post.publicacao = {
			...anterior,
			pedido,
			estado: "rascunho",
			rodada: anterior.rodada + 1,
			midia: undefined,
			pergunta: undefined,
		};
		registrar(
			novo.post.publicacao,
			"rascunho",
			`rodada ${anterior.rodada + 1}: imagens refeitas`,
		);
		novo.salvar();
	} else {
		pub.estado = "rascunho";
		pub.rodada += 1;
		pub.legenda = undefined;
		pub.legendaFacebook = undefined;
		pub.pergunta = undefined;
		registrar(pub, "rascunho", `rodada ${pub.rodada}: só a legenda`);
		salvar();
	}
	console.log(`Rodada ${anterior.rodada + 1} aberta em ${rel(pasta)}.`);
}

function conferirLegenda(arquivo: string, regras: RegrasLegenda, nome: string) {
	if (!existsSync(arquivo)) falhar(`falta ${rel(arquivo)}`);
	const analise = analisarLegenda(readFileSync(arquivo, "utf8"), regras);
	if (analise.problemas.length) {
		console.error(`${nome} fora das regras do projeto:`);
		for (const p of analise.problemas)
			console.error(`  - ${p.regra}: ${p.detalhe}`);
		process.exit(1);
	}
	return analise;
}

function legenda(projeto: string, pastaPost: string) {
	const config = lerConfig(projeto);
	const { pasta, post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	exigirEstado(pub, "rascunho");
	const ig = conferirLegenda(
		join(pasta, "legenda.txt"),
		config.legenda,
		"legenda.txt",
	);
	pub.legenda = {
		arquivo: "legenda.txt",
		texto: ig.texto,
		hashtags: ig.hashtags,
		cta: ig.cta,
		conferidaEm: agora(),
	};
	console.log(
		`legenda.txt ok: ${ig.palavras} palavras, ${ig.hashtags.length} hashtags, CTA "${ig.cta ?? "-"}"`,
	);
	if (config.facebook?.espelhar && config.legendaFacebook) {
		const fb = conferirLegenda(
			join(pasta, "legenda-facebook.txt"),
			config.legendaFacebook,
			"legenda-facebook.txt",
		);
		pub.legendaFacebook = {
			arquivo: "legenda-facebook.txt",
			texto: fb.texto,
			conferidaEm: agora(),
		};
		console.log(
			`legenda-facebook.txt ok: ${fb.palavras} palavras, ${fb.hashtags.length} hashtags`,
		);
	}
	registrar(pub, "legenda", ig.cta);
	salvar();
}

function hospedar(projeto: string, pastaPost: string) {
	const { pasta, post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	exigirEstado(pub, "rascunho");
	const escolhidas = post.revisao?.escolhidas ?? [];
	if (!escolhidas.length)
		falhar("nenhuma variação escolhida; rode imagens.ts escolher antes");
	if (
		post.formato === "carrossel" &&
		(escolhidas.length < 2 || escolhidas.length > 10)
	) {
		falhar(`um carrossel tem de 2 a 10 imagens; este tem ${escolhidas.length}`);
	}
	if (!existsSync(UPLOAD))
		falhar(`script de hospedagem não encontrado: ${rel(UPLOAD)}`);
	pub.midia = escolhidas.map((e) => {
		const url =
			rodar([UPLOAD, join(pasta, e.arquivo), "--check"], { capturar: true })
				.split("\n")
				.pop() ?? "";
		if (!/^https:\/\//.test(url))
			falhar(`o upload de ${e.arquivo} não devolveu uma URL https: "${url}"`);
		console.log(`${e.arquivo} → ${url}`);
		return { arquivo: e.arquivo, url, enviadoEm: agora() };
	});
	registrar(pub, "hospedado", `${pub.midia.length} imagem(ns)`);
	salvar();
}

/**
 * A pergunta que o agente do card faz com AskUserQuestion. As imagens vão como Markdown com
 * caminho absoluto: o Kanban as tira do texto e o conector do Telegram as manda como foto, com
 * os botões embaixo.
 */
function pergunta(projeto: string, pastaPost: string) {
	const config = lerConfig(projeto);
	const { pasta, post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	exigirEstado(pub, "rascunho", "aguardando_aprovacao");
	if (!pub.legenda)
		falhar('a legenda ainda não foi conferida; rode "publicacao.ts legenda"');
	if (
		config.facebook?.espelhar &&
		config.legendaFacebook &&
		!pub.legendaFacebook
	) {
		falhar("falta conferir legenda-facebook.txt");
	}
	if (!pub.midia?.length)
		falhar(
			'as imagens ainda não têm URL pública; rode "publicacao.ts hospedar"',
		);
	const destino = [
		`Instagram${config.instagram.usuario ? ` @${config.instagram.usuario}` : ""}`,
		config.facebook?.espelhar && config.facebook.pageId
			? `Página ${config.facebook.nome ?? config.facebook.pageId}`
			: undefined,
	]
		.filter(Boolean)
		.join(" + ");
	const ultimoAjuste = pub.aprovacoes
		.filter((a) => a.decisao === "ajuste")
		.at(-1);
	const texto = [
		`Aprovar o post ${post.slug} (${post.data}, ${post.formato}${post.formato === "carrossel" ? ` de ${pub.midia.length}` : ""}, rodada ${pub.rodada}) para ${destino}?`,
		ultimoAjuste?.comentario
			? `Ajuste pedido: ${ultimoAjuste.comentario}`
			: undefined,
		`Legenda:\n${pub.legenda.texto}`,
		pub.midia
			.map((m) => `![${m.arquivo}](${join(pasta, m.arquivo)})`)
			.join(" "),
	]
		.filter(Boolean)
		.join("\n\n");
	pub.estado = "aguardando_aprovacao";
	pub.pergunta = { feitaEm: agora(), rodada: pub.rodada };
	registrar(pub, "pergunta", `rodada ${pub.rodada}`);
	salvar();
	console.log(
		JSON.stringify(
			{
				questions: [
					{
						question: texto,
						header: "Aprovação",
						multiSelect: false,
						options: [
							{
								label: OPCOES_APROVACAO[0],
								description: "Publica agora, se couber no limite do dia",
							},
							{
								label: OPCOES_APROVACAO[1],
								description: "Volta ao rascunho com o seu comentário",
							},
							{
								label: OPCOES_APROVACAO[2],
								description: "Arquiva o rascunho sem publicar",
							},
						],
					},
				],
			},
			null,
			"\t",
		),
	);
}

function decisao(
	projeto: string,
	pastaPost: string,
	resposta: string,
	comentario?: string,
) {
	const { post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	const escolha = lerDecisao(resposta);
	if (!escolha)
		falhar(`resposta "${resposta}" não é ${OPCOES_APROVACAO.join(" / ")}`);
	if (escolha === "ajuste" && !comentario?.trim()) {
		falhar('"Pedir ajuste" precisa de --comentario com o que mudar');
	}
	try {
		pub.estado = aplicarDecisao(pub.estado, escolha);
	} catch (erro) {
		falhar((erro as Error).message);
	}
	pub.aprovacoes.push({
		rodada: pub.rodada,
		decisao: escolha,
		...(comentario?.trim() ? { comentario: comentario.trim() } : {}),
		em: agora(),
	});
	registrar(pub, escolha, comentario?.trim());
	salvar();
	console.log(`Post ${post.slug}: ${pub.estado}.`);
}

// ---------------------------------------------------------------------------------------------
// Teto diário e publicação

/** Publicações do projeto que ocupam o teto: as publicadas e as agendadas, menos a própria. */
function ocupados(projeto: string, exceto?: string) {
	const posts = join(pastaDoProjeto(projeto), "posts");
	if (!existsSync(posts)) return [];
	return readdirSync(posts).flatMap((nome) => {
		const caminho = join(posts, nome, "post.json");
		if (nome === exceto || !existsSync(caminho)) return [];
		const pub = lerJson<Post>(caminho).publicacao;
		const quando =
			pub?.estado === "publicado"
				? pub.instagram?.publicadoEm
				: pub?.estado === "agendado"
					? pub.agendadoPara
					: undefined;
		return quando
			? [{ post: nome, estado: pub?.estado, em: Date.parse(quando) }]
			: [];
	});
}

function alvoDe(config: Config, em?: string) {
	return em ? instanteLocal(em, config.offset) : Date.now();
}

function local(config: Config, t: number) {
	return new Date(t).toLocaleString("pt-BR", { timeZone: config.fusoHorario });
}

function cota(projeto: string, em?: string) {
	const config = lerConfig(projeto);
	const alvo = alvoDe(config, em);
	const lista = ocupados(projeto);
	const { cabe, contagem } = cabeNaJanela(
		alvo,
		lista.map((o) => o.em),
		config.limitePorDia,
	);
	console.log(
		`${projeto} · ${local(config, alvo)} · ${contagem} publicação(ões) na janela de 24h · limite ${config.limitePorDia}`,
	);
	for (const o of lista.filter((o) => Math.abs(o.em - alvo) < 24 * 3600_000)) {
		console.log(`  - ${o.post} (${o.estado} ${local(config, o.em)})`);
	}
	if (!cabe) {
		const proximo = proximoDiaLivre(
			alvo,
			lista.map((o) => o.em),
			config.limitePorDia,
		);
		console.log(
			`Não cabe. Próximo dia livre: ${proximo ? local(config, proximo) : "nenhum em 30 dias"}`,
		);
		process.exit(2);
	}
	console.log("Cabe.");
}

async function publicar(
	projeto: string,
	pastaPost: string,
	opcoes: { em?: string; empurrar: boolean; soFacebook: boolean },
) {
	const config = lerConfig(projeto);
	const { pasta, post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);

	if (opcoes.soFacebook) {
		exigirEstado(pub, "publicado");
		await espelharNoFacebook(criarComposio(), config, pub);
		salvar();
		return;
	}
	exigirEstado(pub, "aprovado", "agendado");
	if (
		!pub.aprovacoes.some(
			(a) => a.decisao === "aprovar" && a.rodada === pub.rodada,
		)
	) {
		falhar(`a rodada ${pub.rodada} não foi aprovada`);
	}
	if (!pub.legenda || !pub.midia?.length)
		falhar("falta legenda ou mídia hospedada");
	if (post.formato === "carrossel" && pub.midia.length < 2)
		falhar("carrossel com menos de 2 imagens");

	const alvo = opcoes.em ? alvoDe(config, opcoes.em) : Date.now();
	if (
		pub.estado === "agendado" &&
		pub.agendadoPara &&
		Date.parse(pub.agendadoPara) > alvo
	) {
		falhar(
			`agendado para ${local(config, Date.parse(pub.agendadoPara))}; rode de novo a partir daí`,
		);
	}

	// 1. Teto do projeto: publicados e agendados, numa janela de 24h.
	const lista = ocupados(projeto, basename(pasta));
	const janela = cabeNaJanela(
		Date.now(),
		lista.map((o) => o.em),
		config.limitePorDia,
	);
	pub.cota = {
		verificadaEm: agora(),
		projeto: { contagem: janela.contagem, limite: config.limitePorDia },
	};
	if (!janela.cabe) {
		const proximo = proximoDiaLivre(
			Date.now(),
			lista.map((o) => o.em),
			config.limitePorDia,
		);
		if (opcoes.empurrar && proximo) {
			pub.estado = "agendado";
			pub.agendadoPara = new Date(proximo).toISOString();
			registrar(
				pub,
				"agendado",
				`teto de ${config.limitePorDia}/dia atingido; empurrado para ${local(config, proximo)}`,
			);
			salvar();
			console.log(
				`Teto do projeto atingido (${janela.contagem}/${config.limitePorDia}). Agendado para ${local(config, proximo)}: rode "publicar" de novo nesse horário.`,
			);
			return;
		}
		registrar(pub, "recusado", `teto de ${config.limitePorDia}/dia atingido`);
		salvar();
		falhar(
			`o projeto já tem ${janela.contagem} publicações na janela de 24h (limite ${config.limitePorDia}). Próximo dia livre: ${proximo ? local(config, proximo) : "nenhum"}. Use --empurrar para agendar.`,
		);
	}

	// 2. Conta e limite da Meta (content_publishing_limit).
	// O cliente só nasce aqui: o que o projeto recusa não precisa da chave nem da rede.
	const composio = criarComposio();
	const contaIg = config.instagram.contaComposio;
	const igUserId = config.instagram.igUserId;
	if (!igUserId)
		falhar('o projeto não fixou a conta do Instagram; rode "conexao --salvar"');
	const limiteMeta = await composio.executar(
		"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		{ ig_user_id: igUserId, fields: "quota_usage,config" },
		contaIg,
	);
	const uso = Number(acharCampo(limiteMeta, "quota_usage") ?? Number.NaN);
	const total = Number(acharCampo(limiteMeta, "quota_total") ?? Number.NaN);
	pub.cota.meta = { quota_usage: uso, quota_total: total };
	if (Number.isNaN(uso)) {
		falhar(
			`não consegui ler o content_publishing_limit: ${JSON.stringify(limiteMeta).slice(0, 400)}`,
		);
	}
	if (!Number.isNaN(total) && uso >= total) {
		registrar(pub, "recusado", `limite da Meta ${uso}/${total}`);
		salvar();
		falhar(
			`a conta já usou ${uso} de ${total} publicações pela API nas últimas 24h`,
		);
	}
	console.log(
		`Teto do projeto ${janela.contagem}/${config.limitePorDia} · limite da Meta ${uso}/${Number.isNaN(total) ? "?" : total}`,
	);

	// 3. Container e publicação. O carrossel inteiro é um container só (os slides vão por
	// child_image_urls) e uma publicação só. O publish espera o container ficar pronto.
	const legendaIg = pub.legenda.texto;
	const container =
		post.formato === "carrossel"
			? await composio.executar(
					"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
					{
						ig_user_id: igUserId,
						child_image_urls: pub.midia.map((m) => m.url),
						caption: legendaIg,
					},
					contaIg,
				)
			: await composio.executar(
					"INSTAGRAM_POST_IG_USER_MEDIA",
					{
						ig_user_id: igUserId,
						image_url: pub.midia[0].url,
						caption: legendaIg,
					},
					contaIg,
				);
	const creationId = String(acharCampo(container, "id") ?? "");
	if (!creationId)
		falhar(
			`o container não voltou com id: ${JSON.stringify(container).slice(0, 400)}`,
		);
	const filhos = acharCampo(container, "children");
	pub.instagram = {
		igUserId,
		creationId,
		containers: Array.isArray(filhos)
			? filhos.map((f) => String((f as { id?: string }).id ?? f))
			: [],
	};
	registrar(pub, "container", creationId);
	salvar();

	const publicado = await composio.executar(
		"INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
		{ ig_user_id: igUserId, creation_id: creationId, max_wait_seconds: 120 },
		contaIg,
	);
	const mediaId = String(acharCampo(publicado, "id") ?? "");
	if (!mediaId)
		falhar(
			`publicado sem media id na resposta: ${JSON.stringify(publicado).slice(0, 400)}`,
		);
	const midia = await composio.executar(
		"INSTAGRAM_GET_IG_MEDIA",
		{
			ig_media_id: mediaId,
			fields: "id,permalink,timestamp,caption,media_type",
		},
		contaIg,
	);
	pub.instagram.mediaId = mediaId;
	pub.instagram.permalink = String(acharCampo(midia, "permalink") ?? "");
	pub.instagram.publicadoEm = String(acharCampo(midia, "timestamp") ?? agora());
	pub.instagram.legendaPublicada = String(acharCampo(midia, "caption") ?? "");
	pub.estado = "publicado";
	pub.agendadoPara = undefined;
	registrar(pub, "publicado", `${mediaId} ${pub.instagram.permalink}`);
	salvar();
	console.log(`Instagram: media ${mediaId} · ${pub.instagram.permalink}`);
	if (pub.instagram.legendaPublicada.trim() !== legendaIg.trim()) {
		console.warn(
			"aviso: a legenda publicada difere da aprovada; confira o post (hashtags e quebras de linha)",
		);
	}

	// 4. Página do Facebook, quando o projeto espelha. Falhar aqui não desfaz o Instagram.
	await espelharNoFacebook(composio, config, pub);
	salvar();
}

async function espelharNoFacebook(
	composio: Composio,
	config: Config,
	pub: Publicacao,
) {
	const fb = config.facebook;
	if (!fb?.espelhar || !fb.pageId) return;
	if (pub.facebook?.postId) {
		console.log(`Facebook já publicado: ${pub.facebook.postId}`);
		return;
	}
	const mensagem = pub.legendaFacebook?.texto ?? pub.legenda?.texto ?? "";
	const urls = (pub.midia ?? []).map((m) => m.url);
	try {
		const resposta =
			urls.length > 1
				? await composio.executar(
						"FACEBOOK_CREATE_MULTI_PHOTO_POST",
						{ page_id: fb.pageId, message: mensagem, photo_urls: urls },
						fb.contaComposio,
					)
				: await composio.executar(
						"FACEBOOK_CREATE_PHOTO_POST",
						{
							page_id: fb.pageId,
							url: urls[0],
							message: mensagem,
							published: true,
						},
						fb.contaComposio,
					);
		const postId = String(
			acharCampo(resposta, "post_id") ?? acharCampo(resposta, "id") ?? "",
		);
		if (!postId)
			throw new Error(`sem post id: ${JSON.stringify(resposta).slice(0, 300)}`);
		const detalhes = await composio.executar(
			"FACEBOOK_GET_POST",
			{ post_id: postId, fields: "id,permalink_url,created_time" },
			fb.contaComposio,
		);
		pub.facebook = {
			pageId: fb.pageId,
			postId,
			permalink: String(acharCampo(detalhes, "permalink_url") ?? ""),
			publicadoEm: String(acharCampo(detalhes, "created_time") ?? agora()),
		};
		registrar(pub, "facebook", `${postId} ${pub.facebook.permalink}`);
		console.log(`Facebook: post ${postId} · ${pub.facebook.permalink}`);
	} catch (erro) {
		const mensagemErro = (erro as Error).message;
		pub.facebook = { pageId: fb.pageId, erro: mensagemErro };
		registrar(pub, "facebook-falhou", mensagemErro);
		console.error(
			`aviso: Instagram publicado, Página não: ${mensagemErro}. Tente de novo com --so-facebook.`,
		);
	}
}

/**
 * Para o post de teste. A Página apaga pela API; o Instagram não tem ação de apagar mídia
 * (nem na Graph API, nem no Composio), então ali o post é apagado à mão no app e este comando
 * só registra.
 */
async function remover(projeto: string, pastaPost: string) {
	const config = lerConfig(projeto);
	const { post, salvar } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	exigirEstado(pub, "publicado");
	if (pub.facebook?.postId) {
		await criarComposio().executar(
			"FACEBOOK_DELETE_POST",
			{ post_id: pub.facebook.postId },
			config.facebook?.contaComposio,
		);
		console.log(`Facebook: post ${pub.facebook.postId} apagado.`);
	}
	pub.estado = "removido";
	pub.removidoEm = agora();
	registrar(pub, "removido", "Instagram: apagar à mão no app");
	salvar();
	console.log(
		`Instagram: apague à mão ${pub.instagram?.permalink ?? "(sem permalink)"} (Mais opções → Excluir).`,
	);
}

function estado(projeto: string, pastaPost: string) {
	const { post } = abrirPost(projeto, pastaPost);
	const pub = publicacaoDe(post);
	console.log(
		JSON.stringify(
			{
				slug: post.slug,
				data: post.data,
				formato: post.formato,
				...pub,
				pedido: undefined,
			},
			null,
			"\t",
		),
	);
}

// ---------------------------------------------------------------------------------------------

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		salvar: { type: "boolean", default: false },
		pagina: { type: "string" },
		data: { type: "string" },
		comentario: { type: "string" },
		pedido: { type: "string" },
		"so-legenda": { type: "boolean", default: false },
		em: { type: "string" },
		empurrar: { type: "boolean", default: false },
		"so-facebook": { type: "boolean", default: false },
	},
});
const [comando, projeto, alvo, resposta] = positionals;
if (!comando || !projeto) {
	falhar(
		"uso: publicacao.ts <conexao|calendario|rascunho|legenda|hospedar|pergunta|decisao|refazer|cota|publicar|remover|estado> <projeto> …",
	);
}
const exigir = (valor: string | undefined, nome: string) =>
	valor ?? falhar(`falta ${nome}`);

switch (comando) {
	case "conexao":
		await conexao(projeto, { salvar: values.salvar, pagina: values.pagina });
		break;
	case "calendario": {
		const ano = Number((values.data ?? new Date().toISOString()).slice(0, 4));
		const itens = lerCalendario(projeto, ano).filter(
			(i) => !values.data || i.data === values.data,
		);
		console.log(JSON.stringify(itens, null, "\t"));
		break;
	}
	case "rascunho":
		rascunho(projeto, exigir(alvo, "<pedido.json>"));
		break;
	case "legenda":
		legenda(projeto, exigir(alvo, "<pasta-do-post>"));
		break;
	case "hospedar":
		hospedar(projeto, exigir(alvo, "<pasta-do-post>"));
		break;
	case "pergunta":
		pergunta(projeto, exigir(alvo, "<pasta-do-post>"));
		break;
	case "decisao":
		decisao(
			projeto,
			exigir(alvo, "<pasta-do-post>"),
			exigir(resposta, "<resposta>"),
			values.comentario,
		);
		break;
	case "refazer":
		refazer(projeto, exigir(alvo, "<pasta-do-post>"), {
			pedido: values.pedido,
			soLegenda: values["so-legenda"],
		});
		break;
	case "cota":
		cota(projeto, values.em);
		break;
	case "publicar":
		await publicar(projeto, exigir(alvo, "<pasta-do-post>"), {
			em: values.em,
			empurrar: values.empurrar,
			soFacebook: values["so-facebook"],
		});
		break;
	case "remover":
		await remover(projeto, exigir(alvo, "<pasta-do-post>"));
		break;
	case "estado":
		estado(projeto, exigir(alvo, "<pasta-do-post>"));
		break;
	default:
		falhar(`comando desconhecido: ${comando}`);
}
