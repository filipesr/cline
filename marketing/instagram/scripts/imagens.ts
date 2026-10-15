#!/usr/bin/env bun
/**
 * Motor de imagens dos posts do Instagram: FLUX.2 klein rodando local via mflux (MLX).
 *
 *   bun marketing/instagram/scripts/imagens.ts brief     <projeto> <pedido.json>
 *   bun marketing/instagram/scripts/imagens.ts gerar     <projeto> <pedido.json> [--variacoes N] [--forcar]
 *   bun marketing/instagram/scripts/imagens.ts revisar   <projeto> <pasta-do-post>
 *   bun marketing/instagram/scripts/imagens.ts escolher  <projeto> <pasta-do-post> --escolha v2 --motivo "..." [--descartar "01-v1=motivo"]...
 *
 * Tudo é por projeto: campanha, persona, direção visual, assets e histórico vêm de
 * marketing/instagram/projects/<projeto>/ e nada é lido de outro projeto. Os prompts são
 * escritos pelo agente (campo `cena` de cada imagem, depois de ler o `brief`); o script
 * só acrescenta a direção visual do projeto, as regras de referência e de "sem texto".
 */
import { createHash, randomInt } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const RAIZ = resolve(import.meta.dir, "..");
const PIXELS = join(import.meta.dir, "imagens_pixels.py");
const MAX_POSTS_POR_DIA = 3;
const MAX_REFERENCIAS = 3;
const EXTENSOES_IMAGEM = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Modelo escolhido na comparação do README: klein 4B destilado, em bf16. Quantizar
// (q8/q4) não ganhou tempo nem pico de memória neste Mac e o q4 perde fidelidade.
const MODELO: {
	nome: string;
	quantizar: number | null;
	passos: number;
	guidance: number;
} = {
	nome: "flux2-klein-4b",
	quantizar: null,
	passos: 4,
	guidance: 1.0,
};

// O FLUX trabalha em múltiplos de 16; gera-se um pouco maior na mesma proporção e o
// recorte final leva ao tamanho exato do Instagram.
const PROPORCOES = {
	feed: { largura: 1080, altura: 1350, geracao: [1088, 1360] },
	quadrado: { largura: 1080, altura: 1080, geracao: [1088, 1088] },
	story: { largura: 1080, altura: 1920, geracao: [1088, 1936] },
} as const;
type Proporcao = keyof typeof PROPORCOES;
type Formato = "post" | "carrossel" | "story";

type Pedido = {
	ideia: string;
	pilar: string;
	formato: Formato;
	quantidade: number;
	proporcao?: "feed" | "quadrado";
	variacoes?: number;
	slug?: string;
	data?: string;
	seeds?: number[];
	/** Nomes de arquivos em assets/. Omitido: todos os assets do projeto. []: nenhum. */
	referencias?: string[];
	imagens?: { cena?: string }[];
};

type Variacao = {
	id: string;
	seed: number;
	arquivo: string;
	bytes: number;
	qualidadeJpeg: number;
	/** Tempo do processo inteiro, carga do modelo incluída. */
	segundos: number;
	/** Rodado em marketing/instagram/; repetir o comando refaz a imagem bruta igual. */
	comando: string[];
};
type ImagemGerada = {
	n: string;
	cena: string;
	prompt: string;
	promptArquivo: string;
	variacoes: Variacao[];
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

function pastaDoProjeto(projeto: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(projeto))
		falhar(`nome de projeto inválido: ${projeto}`);
	const pasta = join(RAIZ, "projects", projeto);
	if (!existsSync(pasta))
		falhar(`projeto não existe: ${relative(process.cwd(), pasta)}`);
	return pasta;
}

function hash(caminho: string) {
	return createHash("sha256")
		.update(readFileSync(caminho))
		.digest("hex")
		.slice(0, 16);
}

/** Primeiro arquivo que existir entre os nomes aceitos (persona.md, contexto.md…). */
function arquivoDoProjeto(pasta: string, nomes: string[]) {
	return nomes
		.map((nome) => join(pasta, nome))
		.find((caminho) => existsSync(caminho));
}

/**
 * Seção "Direção visual" da campanha (aceita numeração, como "## 9. Direção visual").
 * O estilo do prompt sai, nesta ordem, de um bloco ```prompt, de um bloco-modelo com
 * [CENA: …] (a cena entra no lugar dele) ou do texto da seção.
 */
function direcaoVisual(campanha: string) {
	const linhas = readFileSync(campanha, "utf8").split("\n");
	const inicio = linhas.findIndex((linha) =>
		/^#{1,6}\s+(?:\d+[.)]?\s+)?dire[çc][ãa]o visual/i.test(linha),
	);
	if (inicio < 0)
		falhar(`${relative(RAIZ, campanha)} não tem a seção "Direção visual"`);
	const nivelDe = (linha: string) => linha.match(/^#+/)?.[0].length ?? 0;
	const nivel = nivelDe(linhas[inicio]);
	const fim = linhas.findIndex(
		(linha, i) => i > inicio && /^#+\s/.test(linha) && nivelDe(linha) <= nivel,
	);
	const secao = linhas
		.slice(inicio + 1, fim < 0 ? undefined : fim)
		.join("\n")
		.trim();
	const compactar = (texto: string) => texto.replace(/\s+/g, " ").trim();
	const bloco = secao.match(/```prompt\n([\s\S]*?)```/);
	const modelo = bloco
		? undefined
		: [...secao.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
				.map((m) => m[1])
				.find((texto) => /\[CENA\b/i.test(texto));
	if (modelo)
		return { secao, estilo: compactar(modelo), modelo: compactar(modelo) };
	const estilo = compactar(
		bloco
			? bloco[1]
			: secao.replace(/```[\s\S]*?```/g, "").replace(/[#*_>`-]/g, " "),
	);
	if (!estilo)
		falhar(
			`a seção "Direção visual" de ${relative(RAIZ, campanha)} está vazia`,
		);
	return { secao, estilo, modelo: undefined };
}

const FORMATO_NO_PROMPT: Record<Proporcao, string> = {
	feed: "vertical 4:5",
	quadrado: "square 1:1",
	story: "vertical 9:16",
};

/** Preenche o bloco-modelo da campanha: [CENA: …], [FORMATO: …] e escolhas [a|b] (fica a primeira). */
function preencherModelo(modelo: string, cena: string, proporcao: Proporcao) {
	return modelo
		.replace(/\[CENA\b[^\]]*\]/gi, cena.trim().replace(/\.$/, ""))
		.replace(/\[FORMATO\b[^\]]*\]/gi, FORMATO_NO_PROMPT[proporcao])
		.replace(/\[([^\]|]+)\|[^\]]*\]/g, "$1");
}

function assetsDoProjeto(pasta: string) {
	const dir = join(pasta, "assets");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((nome) => EXTENSOES_IMAGEM.has(extname(nome).toLowerCase()))
		.sort();
}

function contexto(projeto: string) {
	const pasta = pastaDoProjeto(projeto);
	const campanha = join(pasta, "campaign.md");
	if (!existsSync(campanha)) falhar(`projeto ${projeto} não tem campaign.md`);
	return {
		pasta,
		campanha,
		persona: arquivoDoProjeto(pasta, ["persona.md"]),
		contexto: arquivoDoProjeto(pasta, ["contexto.md", "context.md"]),
		direcao: direcaoVisual(campanha),
		assets: assetsDoProjeto(pasta),
	};
}

function slugificar(texto: string) {
	return texto
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.split("-")
		.slice(0, 6)
		.join("-");
}

function hoje() {
	const agora = new Date();
	return new Date(agora.getTime() - agora.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 10);
}

function validarPedido(pedido: Pedido, assets: string[]) {
	if (!pedido.ideia?.trim()) falhar("pedido sem `ideia`");
	if (!pedido.pilar?.trim()) falhar("pedido sem `pilar`");
	if (!["post", "carrossel", "story"].includes(pedido.formato))
		falhar("`formato` deve ser post, carrossel ou story");
	const quantidade = pedido.quantidade ?? 1;
	if (pedido.formato === "carrossel" && (quantidade < 2 || quantidade > 20))
		falhar("carrossel tem de 2 a 20 imagens");
	if (pedido.formato !== "carrossel" && quantidade !== 1)
		falhar(`${pedido.formato} tem uma imagem só`);
	if (pedido.formato === "story" && pedido.proporcao)
		falhar("story é sempre 1080x1920; tire `proporcao`");
	if (pedido.proporcao && !["feed", "quadrado"].includes(pedido.proporcao))
		falhar("`proporcao` deve ser feed ou quadrado");
	if (pedido.data && !/^\d{4}-\d{2}-\d{2}$/.test(pedido.data))
		falhar("`data` deve ser AAAA-MM-DD");
	for (const nome of pedido.referencias ?? []) {
		if (!assets.includes(nome))
			falhar(
				`referência ${nome} não está em assets/ (há: ${assets.join(", ") || "nada"})`,
			);
	}
	return quantidade;
}

function referenciasDoPedido(pedido: Pedido, assets: string[]) {
	const escolhidas = pedido.referencias ?? assets;
	if (escolhidas.length > MAX_REFERENCIAS) {
		falhar(
			`há ${escolhidas.length} imagens de referência; o FLUX.2 klein aceita bem até ${MAX_REFERENCIAS}. Liste em \`referencias\` as que este post usa.`,
		);
	}
	return escolhidas;
}

function montarPrompt(
	cena: string,
	direcao: { estilo: string; modelo?: string },
	proporcao: Proporcao,
	comReferencias: boolean,
	slide?: { n: number; total: number },
) {
	const partes = [
		direcao.modelo
			? preencherModelo(direcao.modelo, cena, proporcao)
			: cena.trim().replace(/\.?$/, "."),
	];
	if (comReferencias) {
		partes.push(
			"The product shown in the reference image(s) must appear exactly as it is: same shape, proportions, colors, logo and screen content. Do not redraw, restyle or invent any interface, logo or lettering.",
		);
	}
	if (slide) {
		partes.push(
			`Slide ${slide.n} of ${slide.total} of one carousel series: identical palette, lighting, lens and art direction across every slide.`,
		);
	}
	if (!direcao.modelo)
		partes.push(`Visual direction: ${direcao.estilo.replace(/\.?$/, ".")}`);
	partes.push(
		comReferencias
			? "No added text, letters, words, captions, watermarks or extra logos anywhere in the image; only what is already on the reference product."
			: "No text, letters, words, captions, logos or watermarks anywhere in the image.",
	);
	return partes.join(" ");
}

function executavel(nome: string) {
	const caminho = Bun.which(nome, {
		PATH: `${process.env.PATH}:${join(homedir(), ".local", "bin")}`,
	});
	if (!caminho)
		falhar(
			`${nome} não encontrado; instale com \`uv tool install mflux\` (veja o README)`,
		);
	return caminho;
}

function pythonDoMflux() {
	const python =
		process.env.MFLUX_PYTHON ??
		join(homedir(), ".local", "share", "uv", "tools", "mflux", "bin", "python");
	if (!existsSync(python))
		falhar(`Python do mflux não encontrado em ${python} (defina MFLUX_PYTHON)`);
	return python;
}

function pixels(...args: string[]) {
	const resultado = Bun.spawnSync([pythonDoMflux(), "-I", PIXELS, ...args], {
		stderr: "inherit",
	});
	if (resultado.exitCode !== 0) falhar(`imagens_pixels.py ${args[0]} falhou`);
	const saida = resultado.stdout.toString().trim();
	return saida ? JSON.parse(saida) : undefined;
}

function postsDoDia(pastaPosts: string, data: string, slug: string) {
	if (!existsSync(pastaPosts)) return [];
	return readdirSync(pastaPosts).filter(
		(nome) => nome.startsWith(`${data}-`) && nome !== `${data}-${slug}`,
	);
}

function versaoMflux() {
	const resultado = Bun.spawnSync(["uv", "tool", "list"], { stderr: "ignore" });
	return (
		resultado.stdout.toString().match(/^mflux v(\S+)/m)?.[1] ?? "desconhecida"
	);
}

// ---------------------------------------------------------------------------- brief

function brief(projeto: string, arquivoPedido: string) {
	const ctx = contexto(projeto);
	const pedido = lerJson<Pedido>(arquivoPedido);
	const quantidade = validarPedido(pedido, ctx.assets);
	const referencias = referenciasDoPedido(pedido, ctx.assets);
	const proporcao: Proporcao =
		pedido.formato === "story" ? "story" : (pedido.proporcao ?? "feed");
	const ler = (caminho?: string) =>
		caminho
			? readFileSync(caminho, "utf8").trim()
			: "(o projeto não tem este arquivo)";
	const historico = existsSync(join(ctx.pasta, "posts"))
		? readdirSync(join(ctx.pasta, "posts")).sort().slice(-10)
		: [];
	console.log(`# Brief de imagens — projeto ${projeto}

Pedido: ${pedido.formato}, ${quantidade} imagem(ns), ${PROPORCOES[proporcao].largura}x${PROPORCOES[proporcao].altura}
Ideia: ${pedido.ideia}
Pilar: ${pedido.pilar}

## Contexto
${ler(ctx.contexto)}

## Persona
${ler(ctx.persona)}

## Campanha (campaign.md)
${ler(ctx.campanha)}

${
	ctx.direcao.modelo
		? `## Modelo de prompt da campanha (a cena entra no lugar de [CENA])\n${ctx.direcao.modelo}`
		: `## Estilo que o script acrescenta a todo prompt (da direção visual)\n${ctx.direcao.estilo}`
}

## Referências reais que vão junto (assets/)
${referencias.length ? referencias.map((nome) => `- assets/${nome}`).join("\n") : "- nenhuma: a imagem não pode mostrar tela, logo ou produto inventado"}

## Últimos posts deste projeto
${historico.map((nome) => `- ${nome}`).join("\n") || "- nenhum"}

## O que escrever
Preencha \`imagens\` no pedido com ${quantidade} objeto(s) { "cena": "..." }, em inglês, uma cena por imagem:
- descreva só a cena (assunto, ação, enquadramento, luz); o estilo acima e a regra de "sem texto" o script acrescenta;
- a mensagem vai na legenda: nada de texto, número ou título dentro da imagem;${
		referencias.length
			? '\n- com referências, diga onde o produto entra ("the app icon from the reference image as a glossy 3D object on a desk"), sem descrever a aparência dele;'
			: ""
	}${pedido.formato === "carrossel" ? "\n- carrossel: as cenas contam uma sequência no mesmo cenário/estilo; o script repete seeds e referências em todos os slides." : ""}
Depois: bun marketing/instagram/scripts/imagens.ts gerar ${projeto} ${relative(process.cwd(), arquivoPedido)}`);
}

// ---------------------------------------------------------------------------- gerar

async function gerar(
	projeto: string,
	arquivoPedido: string,
	opcoes: { variacoes?: string; forcar?: boolean },
) {
	const ctx = contexto(projeto);
	const pedido = lerJson<Pedido>(arquivoPedido);
	const quantidade = validarPedido(pedido, ctx.assets);
	const referencias = referenciasDoPedido(pedido, ctx.assets);
	const imagens = pedido.imagens ?? [];
	if (
		imagens.length !== quantidade ||
		imagens.some((imagem) => !imagem.cena?.trim())
	) {
		falhar(
			`o pedido precisa de ${quantidade} imagem(ns) com \`cena\` escrita; rode \`brief\` e preencha \`imagens\``,
		);
	}

	const variacoes = Number(opcoes.variacoes ?? pedido.variacoes ?? 3);
	if (!Number.isInteger(variacoes) || variacoes < 1 || variacoes > 8)
		falhar("variacoes deve ser de 1 a 8");
	const proporcao: Proporcao =
		pedido.formato === "story" ? "story" : (pedido.proporcao ?? "feed");
	const dimensoes = PROPORCOES[proporcao];
	const data = pedido.data ?? hoje();
	const slug = pedido.slug ? slugificar(pedido.slug) : slugificar(pedido.ideia);
	const pastaPosts = join(ctx.pasta, "posts");
	const outros = postsDoDia(pastaPosts, data, slug);
	if (outros.length >= MAX_POSTS_POR_DIA) {
		falhar(
			`o projeto ${projeto} já tem ${outros.length} posts em ${data} (${outros.join(", ")}); o limite é ${MAX_POSTS_POR_DIA} por dia`,
		);
	}
	const pasta = join(pastaPosts, `${data}-${slug}`);
	if (existsSync(pasta) && !opcoes.forcar)
		falhar(
			`${relative(process.cwd(), pasta)} já existe; use --forcar para refazer`,
		);
	rmSync(pasta, { recursive: true, force: true });
	mkdirSync(join(pasta, "prompts"), { recursive: true });
	const bruto = join(pasta, ".bruto");
	mkdirSync(bruto, { recursive: true });

	// As mesmas seeds em todos os slides: a variação vN de um carrossel é um conjunto coerente.
	const seeds =
		pedido.seeds?.slice(0, variacoes) ??
		Array.from({ length: variacoes }, () => randomInt(1, 1_000_000_000));
	if (seeds.length < variacoes)
		falhar(`o pedido traz ${seeds.length} seeds para ${variacoes} variações`);
	const caminhosReferencias = referencias.map((nome) =>
		join(ctx.pasta, "assets", nome),
	);
	const comando = executavel(
		referencias.length ? "mflux-generate-flux2-edit" : "mflux-generate-flux2",
	);

	const geradas: ImagemGerada[] = [];
	for (const [indice, imagem] of imagens.entries()) {
		const n = String(indice + 1).padStart(2, "0");
		const cena = imagem.cena?.trim() ?? "";
		const slide =
			pedido.formato === "carrossel"
				? { n: indice + 1, total: quantidade }
				: undefined;
		const prompt = montarPrompt(
			cena,
			ctx.direcao,
			proporcao,
			referencias.length > 0,
			slide,
		);
		const promptArquivo = join(pasta, "prompts", `${n}.txt`);
		writeFileSync(promptArquivo, `${prompt}\n`);
		const variacoesGeradas: Variacao[] = [];
		for (const [i, seed] of seeds.entries()) {
			const id = `v${i + 1}`;
			const png = join(bruto, `${n}-${id}.png`);
			// Um processo por variação: a carga do modelo custa ~7 s, e uma variação que morre
			// (pressão de memória) não leva as outras junto.
			// biome-ignore format: pares flag/valor
			const args = [
				"--model", MODELO.nome,
				...(MODELO.quantizar ? ["--quantize", String(MODELO.quantizar)] : []),
				"--steps", String(MODELO.passos),
				"--guidance", String(MODELO.guidance),
				"--width", String(dimensoes.geracao[0]),
				"--height", String(dimensoes.geracao[1]),
				"--prompt-file", relative(RAIZ, promptArquivo),
				"--seed", String(seed),
				...(caminhosReferencias.length ? ["--image-paths", ...caminhosReferencias.map((caminho) => relative(RAIZ, caminho))] : []),
				"--output", relative(RAIZ, png),
			]
			let segundos = 0;
			for (let tentativa = 1; ; tentativa++) {
				console.log(
					`\n▶ imagem ${n}/${String(quantidade).padStart(2, "0")}, variação ${id} (seed ${seed})${tentativa > 1 ? ", nova tentativa" : ""}`,
				);
				const inicio = performance.now();
				const processo = Bun.spawn([comando, ...args], {
					cwd: RAIZ,
					stdout: "inherit",
					stderr: "inherit",
				});
				// O mflux sai com 0 mesmo quando interrompe a geração; o arquivo é a prova.
				const ok = (await processo.exited) === 0 && existsSync(png);
				segundos = Math.round((performance.now() - inicio) / 100) / 10;
				if (ok) break;
				if (tentativa === 2)
					falhar(
						`mflux não gerou ${relative(process.cwd(), png)} (veja o log acima)`,
					);
			}
			const arquivo = `${n}-${id}.jpg`;
			const { qualidade } = pixels(
				"finalizar",
				png,
				join(pasta, arquivo),
				String(dimensoes.largura),
				String(dimensoes.altura),
			);
			variacoesGeradas.push({
				id,
				seed,
				arquivo,
				bytes: statSync(join(pasta, arquivo)).size,
				qualidadeJpeg: qualidade,
				segundos,
				comando: [basename(comando), ...args],
			});
			console.log(`✓ ${n}-${id}: ${segundos}s`);
		}
		geradas.push({
			n,
			cena,
			prompt,
			promptArquivo: relative(pasta, promptArquivo),
			variacoes: variacoesGeradas,
		});
	}
	rmSync(bruto, { recursive: true, force: true });

	const post = {
		projeto,
		slug,
		data,
		ideia: pedido.ideia,
		pilar: pedido.pilar,
		formato: pedido.formato,
		quantidade,
		proporcao,
		dimensoes: {
			largura: dimensoes.largura,
			altura: dimensoes.altura,
			geracao: dimensoes.geracao,
		},
		modelo: { ...MODELO, mflux: versaoMflux(), cwd: "marketing/instagram" },
		fontes: Object.fromEntries(
			[ctx.campanha, ctx.persona, ctx.contexto, ...caminhosReferencias]
				.filter((caminho): caminho is string => Boolean(caminho))
				.map((caminho) => [relative(ctx.pasta, caminho), hash(caminho)]),
		),
		direcaoVisual: ctx.direcao.estilo,
		referencias: referencias.map((nome) => `assets/${nome}`),
		seeds,
		imagens: geradas,
		geradoEm: new Date().toISOString(),
		revisao: null,
	};
	salvarJson(join(pasta, "post.json"), post);
	console.log(
		`\nPost salvo em ${relative(process.cwd(), pasta)}\nRevisão: bun marketing/instagram/scripts/imagens.ts revisar ${projeto} ${relative(process.cwd(), pasta)}`,
	);
}

// ---------------------------------------------------------------------------- revisar / escolher

function lerPost(projeto: string, pastaPost: string) {
	const ctx = contexto(projeto);
	const pasta = resolve(pastaPost);
	if (!pasta.startsWith(`${join(ctx.pasta, "posts")}/`))
		falhar(`${pastaPost} não é um post do projeto ${projeto}`);
	const post = lerJson<{
		projeto: string;
		formato: Formato;
		dimensoes: { largura: number; altura: number };
		seeds: number[];
		imagens: ImagemGerada[];
		revisao: unknown;
		[chave: string]: unknown;
	}>(join(pasta, "post.json"));
	if (post.projeto !== projeto)
		falhar(`o post é do projeto ${post.projeto}, não de ${projeto}`);
	return { ctx, pasta, post };
}

function revisar(projeto: string, pastaPost: string) {
	const { ctx, pasta, post } = lerPost(projeto, pastaPost);
	const itens = post.imagens.flatMap((imagem) =>
		imagem.variacoes.map(
			(variacao) =>
				`${imagem.n}-${variacao.id} · seed ${variacao.seed}=${join(pasta, variacao.arquivo)}`,
		),
	);
	const folha = join(pasta, "revisao.jpg");
	pixels(
		"folha",
		folha,
		`${projeto} · ${basename(pasta)} · linhas = imagens, colunas = variações`,
		String(post.seeds.length),
		...itens,
	);
	console.log(`# Revisão — ${basename(pasta)}

Folha de contato: ${relative(process.cwd(), folha)}
Abra também cada variação em tamanho real:
${post.imagens.flatMap((imagem) => imagem.variacoes.map((v) => `- ${relative(process.cwd(), join(pasta, v.arquivo))}`)).join("\n")}
${post.referencias && (post.referencias as string[]).length ? `\nCompare com as referências reais:\n${(post.referencias as string[]).map((r) => `- ${relative(process.cwd(), join(ctx.pasta, r))}`).join("\n")}\n` : ""}
Descarte a variação que:
- distorce o produto (forma, cor, logo ou tela diferentes da referência, ou produto inventado);
- traz texto, letras, números ou marcas d'água;
- foge da direção visual: ${ctx.direcao.estilo}
- tem defeito visível (mãos, rostos, objetos derretidos, recorte ruim na proporção ${post.dimensoes.largura}x${post.dimensoes.altura}).
${post.formato === "carrossel" ? "Carrossel: prefira o mesmo vN em todos os slides (mesma seed = mesma continuidade).\n" : ""}
Depois: bun marketing/instagram/scripts/imagens.ts escolher ${projeto} ${relative(process.cwd(), pasta)} --escolha v2 --motivo "..." [--descartar "01-v1=motivo"]`);
}

function escolher(
	projeto: string,
	pastaPost: string,
	opcoes: { escolha?: string; motivo?: string; descartar?: string[] },
) {
	const { pasta, post } = lerPost(projeto, pastaPost);
	if (!opcoes.escolha)
		falhar('falta --escolha (ex.: "v2" ou "01=v2,02=v2,03=v1")');
	if (!opcoes.motivo?.trim()) falhar("falta --motivo");

	// "v2" vale para todas as imagens; "01=v2,02=v3" escolhe por imagem.
	const porImagem = new Map<string, string>();
	if (/^v\d+$/.test(opcoes.escolha)) {
		for (const imagem of post.imagens) porImagem.set(imagem.n, opcoes.escolha);
	} else {
		for (const par of opcoes.escolha.split(",")) {
			const [n, id] = par.split("=").map((parte) => parte.trim());
			porImagem.set(n.padStart(2, "0"), id);
		}
	}
	const descartadas = (opcoes.descartar ?? []).map((item) => {
		const [id, ...motivo] = item.split("=");
		if (!/^\d{2}-v\d+$/.test(id) || !motivo.join("=").trim())
			falhar(`--descartar "${item}" deve ser "01-v1=motivo"`);
		return { id, motivo: motivo.join("=").trim() };
	});

	mkdirSync(join(pasta, "final"), { recursive: true });
	const escolhidas = post.imagens.map((imagem) => {
		const id = porImagem.get(imagem.n);
		const variacao = imagem.variacoes.find((v) => v.id === id);
		if (!variacao)
			falhar(`imagem ${imagem.n}: variação ${id ?? "(nenhuma)"} não existe`);
		if (descartadas.some((d) => d.id === `${imagem.n}-${variacao.id}`))
			falhar(
				`${imagem.n}-${variacao.id} foi escolhida e descartada ao mesmo tempo`,
			);
		const destino = join(pasta, "final", `${imagem.n}.jpg`);
		copyFileSync(join(pasta, variacao.arquivo), destino);
		const verificacao = pixels("verificar", destino);
		const problemas = [
			verificacao.formato !== "JPEG" && "não é JPEG",
			(verificacao.largura !== post.dimensoes.largura ||
				verificacao.altura !== post.dimensoes.altura) &&
				`tem ${verificacao.largura}x${verificacao.altura}`,
			!/srgb/i.test(verificacao.icc ?? "") &&
				`perfil ${verificacao.icc ?? "ausente"}`,
			verificacao.bytes >= 8 * 1024 * 1024 && "passa de 8 MB",
		].filter(Boolean);
		if (problemas.length)
			falhar(`final/${imagem.n}.jpg ${problemas.join(", ")}`);
		return {
			n: imagem.n,
			variacao: variacao.id,
			seed: variacao.seed,
			arquivo: `final/${imagem.n}.jpg`,
			bytes: verificacao.bytes,
		};
	});

	post.revisao = {
		escolhidas,
		motivo: opcoes.motivo.trim(),
		descartadas,
		revisadoEm: new Date().toISOString(),
	};
	salvarJson(join(pasta, "post.json"), post);
	console.log(
		`Escolha registrada em ${relative(process.cwd(), join(pasta, "post.json"))}:`,
	);
	for (const e of escolhidas)
		console.log(
			`- ${e.arquivo} ← ${e.n}-${e.variacao} (seed ${e.seed}, ${Math.round(e.bytes / 1024)} KB)`,
		);
}

// ---------------------------------------------------------------------------- cli

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		variacoes: { type: "string" },
		forcar: { type: "boolean" },
		escolha: { type: "string" },
		motivo: { type: "string" },
		descartar: { type: "string", multiple: true },
	},
});
const [acao, projeto, alvo] = positionals;
if (!acao || !projeto || !alvo)
	falhar(
		"uso: imagens.ts <brief|gerar|revisar|escolher> <projeto> <pedido.json|pasta-do-post> [opções]",
	);
switch (acao) {
	case "brief":
		brief(projeto, resolve(alvo));
		break;
	case "gerar":
		await gerar(projeto, resolve(alvo), values);
		break;
	case "revisar":
		revisar(projeto, alvo);
		break;
	case "escolher":
		escolher(projeto, alvo, values);
		break;
	default:
		falhar(`ação desconhecida: ${acao}`);
}
