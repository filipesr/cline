#!/usr/bin/env bun
/**
 * Image engine for the Instagram posts: FLUX.2 klein running locally via mflux (MLX).
 *
 *   bun marketing/instagram/scripts/images.ts brief     <project> <request.json>
 *   bun marketing/instagram/scripts/images.ts generate  <project> <request.json> [--variations N] [--force]
 *   bun marketing/instagram/scripts/images.ts review    <project> <post-dir>
 *   bun marketing/instagram/scripts/images.ts choose    <project> <post-dir> --pick v2 --reason "..." [--reject "01-v1=reason"]...
 *
 * Everything is per project: campaign, persona, visual direction, assets and history come from
 * marketing/instagram/projects/<project>/ and nothing is read from another project. The prompts are
 * written by the agent (the `scene` field of each image, after reading the `brief`); the script
 * only adds the project's visual direction, the reference rules and the "no text" rule.
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

const ROOT = resolve(import.meta.dir, "..");
const PIXELS = join(import.meta.dir, "images_pixels.py");
const MAX_POSTS_PER_DAY = 3;
const MAX_REFERENCES = 3;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Model chosen in the README comparison: distilled klein 4B, in bf16. Quantizing
// (q8/q4) gained neither time nor peak memory on this Mac, and q4 loses fidelity.
const MODEL: {
	name: string;
	quantize: number | null;
	steps: number;
	guidance: number;
} = {
	name: "flux2-klein-4b",
	quantize: null,
	steps: 4,
	guidance: 1.0,
};

// FLUX works in multiples of 16; it generates slightly larger at the same aspect ratio and
// the final crop brings it to Instagram's exact size.
const ASPECTS = {
	feed: { width: 1080, height: 1350, generation: [1088, 1360] },
	square: { width: 1080, height: 1080, generation: [1088, 1088] },
	story: { width: 1080, height: 1920, generation: [1088, 1936] },
} as const;
type Aspect = keyof typeof ASPECTS;
type Format = "post" | "carousel" | "story";

type Request = {
	idea: string;
	pillar: string;
	format: Format;
	count: number;
	aspect?: "feed" | "square";
	variations?: number;
	slug?: string;
	date?: string;
	seeds?: number[];
	/** File names in assets/. Omitted: every asset of the project. []: none. */
	references?: string[];
	images?: { scene?: string }[];
};

type Variation = {
	id: string;
	seed: number;
	file: string;
	bytes: number;
	jpegQuality: number;
	/** Time of the whole process, model load included. */
	seconds: number;
	/** Run in marketing/instagram/; repeating the command remakes the same raw image. */
	command: string[];
};
type GeneratedImage = {
	n: string;
	scene: string;
	prompt: string;
	promptFile: string;
	variations: Variation[];
};

function fail(message: string): never {
	console.error(`erro: ${message}`);
	process.exit(1);
}

function readJson<T>(path: string): T {
	if (!existsSync(path)) fail(`arquivo não encontrado: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function projectDir(project: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
		fail(`nome de projeto inválido: ${project}`);
	const dir = join(ROOT, "projects", project);
	if (!existsSync(dir))
		fail(`projeto não existe: ${relative(process.cwd(), dir)}`);
	return dir;
}

function hash(path: string) {
	return createHash("sha256")
		.update(readFileSync(path))
		.digest("hex")
		.slice(0, 16);
}

/** First file that exists among the accepted names (persona.md, context.md…). */
function projectFile(dir: string, names: string[]) {
	return names.map((name) => join(dir, name)).find((path) => existsSync(path));
}

/**
 * The campaign's "Direção visual" section (numbering accepted, as in "## 9. Direção visual").
 * The prompt style comes, in this order, from a ```prompt block, from a template block with
 * [CENA: …] (the scene takes its place) or from the section's text.
 */
function visualDirection(campaign: string) {
	const lines = readFileSync(campaign, "utf8").split("\n");
	const start = lines.findIndex((line) =>
		/^#{1,6}\s+(?:\d+[.)]?\s+)?dire[çc][ãa]o visual/i.test(line),
	);
	if (start < 0)
		fail(`${relative(ROOT, campaign)} não tem a seção "Direção visual"`);
	const levelOf = (line: string) => line.match(/^#+/)?.[0].length ?? 0;
	const level = levelOf(lines[start]);
	const end = lines.findIndex(
		(line, i) => i > start && /^#+\s/.test(line) && levelOf(line) <= level,
	);
	const section = lines
		.slice(start + 1, end < 0 ? undefined : end)
		.join("\n")
		.trim();
	const compact = (text: string) => text.replace(/\s+/g, " ").trim();
	const block = section.match(/```prompt\n([\s\S]*?)```/);
	const template = block
		? undefined
		: [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
				.map((m) => m[1])
				.find((text) => /\[CENA\b/i.test(text));
	if (template)
		return { section, style: compact(template), template: compact(template) };
	const style = compact(
		block
			? block[1]
			: section.replace(/```[\s\S]*?```/g, "").replace(/[#*_>`-]/g, " "),
	);
	if (!style)
		fail(`a seção "Direção visual" de ${relative(ROOT, campaign)} está vazia`);
	return { section, style, template: undefined };
}

const ASPECT_IN_PROMPT: Record<Aspect, string> = {
	feed: "vertical 4:5",
	square: "square 1:1",
	story: "vertical 9:16",
};

/** Fills the campaign's template block: [CENA: …], [FORMATO: …] and [a|b] choices (the first one stays). */
function fillTemplate(template: string, scene: string, aspect: Aspect) {
	return template
		.replace(/\[CENA\b[^\]]*\]/gi, scene.trim().replace(/\.$/, ""))
		.replace(/\[FORMATO\b[^\]]*\]/gi, ASPECT_IN_PROMPT[aspect])
		.replace(/\[([^\]|]+)\|[^\]]*\]/g, "$1");
}

function projectAssets(dir: string) {
	const assetsDir = join(dir, "assets");
	if (!existsSync(assetsDir)) return [];
	return readdirSync(assetsDir)
		.filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
		.sort();
}

function projectContext(project: string) {
	const dir = projectDir(project);
	const campaign = join(dir, "campaign.md");
	if (!existsSync(campaign)) fail(`projeto ${project} não tem campaign.md`);
	return {
		dir,
		campaign,
		persona: projectFile(dir, ["persona.md"]),
		context: projectFile(dir, ["context.md"]),
		direction: visualDirection(campaign),
		assets: projectAssets(dir),
	};
}

function slugify(text: string) {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.split("-")
		.slice(0, 6)
		.join("-");
}

function today() {
	const now = new Date();
	return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 10);
}

function validateRequest(request: Request, assets: string[]) {
	if (!request.idea?.trim()) fail("pedido sem `idea`");
	if (!request.pillar?.trim()) fail("pedido sem `pillar`");
	if (!["post", "carousel", "story"].includes(request.format))
		fail("`format` deve ser post, carousel ou story");
	const count = request.count ?? 1;
	if (request.format === "carousel" && (count < 2 || count > 20))
		fail("carrossel tem de 2 a 20 imagens");
	if (request.format !== "carousel" && count !== 1)
		fail(`${request.format} tem uma imagem só`);
	if (request.format === "story" && request.aspect)
		fail("story é sempre 1080x1920; tire `aspect`");
	if (request.aspect && !["feed", "square"].includes(request.aspect))
		fail("`aspect` deve ser feed ou square");
	if (request.date && !/^\d{4}-\d{2}-\d{2}$/.test(request.date))
		fail("`date` deve ser AAAA-MM-DD");
	for (const name of request.references ?? []) {
		if (!assets.includes(name))
			fail(
				`referência ${name} não está em assets/ (há: ${assets.join(", ") || "nada"})`,
			);
	}
	return count;
}

function requestReferences(request: Request, assets: string[]) {
	const chosen = request.references ?? assets;
	if (chosen.length > MAX_REFERENCES) {
		fail(
			`há ${chosen.length} imagens de referência; o FLUX.2 klein aceita bem até ${MAX_REFERENCES}. Liste em \`references\` as que este post usa.`,
		);
	}
	return chosen;
}

function buildPrompt(
	scene: string,
	direction: { style: string; template?: string },
	aspect: Aspect,
	withReferences: boolean,
	slide?: { n: number; total: number },
) {
	const parts = [
		direction.template
			? fillTemplate(direction.template, scene, aspect)
			: scene.trim().replace(/\.?$/, "."),
	];
	if (withReferences) {
		parts.push(
			"The product shown in the reference image(s) must appear exactly as it is: same shape, proportions, colors, logo and screen content. Do not redraw, restyle or invent any interface, logo or lettering.",
		);
	}
	if (slide) {
		parts.push(
			`Slide ${slide.n} of ${slide.total} of one carousel series: identical palette, lighting, lens and art direction across every slide.`,
		);
	}
	if (!direction.template)
		parts.push(`Visual direction: ${direction.style.replace(/\.?$/, ".")}`);
	parts.push(
		withReferences
			? "No added text, letters, words, captions, watermarks or extra logos anywhere in the image; only what is already on the reference product."
			: "No text, letters, words, captions, logos or watermarks anywhere in the image.",
	);
	return parts.join(" ");
}

function executable(name: string) {
	const path = Bun.which(name, {
		PATH: `${process.env.PATH}:${join(homedir(), ".local", "bin")}`,
	});
	if (!path)
		fail(
			`${name} não encontrado; instale com \`uv tool install mflux\` (veja o README)`,
		);
	return path;
}

function mfluxPython() {
	const python =
		process.env.MFLUX_PYTHON ??
		join(homedir(), ".local", "share", "uv", "tools", "mflux", "bin", "python");
	if (!existsSync(python))
		fail(`Python do mflux não encontrado em ${python} (defina MFLUX_PYTHON)`);
	return python;
}

function pixels(...args: string[]) {
	const result = Bun.spawnSync([mfluxPython(), "-I", PIXELS, ...args], {
		stderr: "inherit",
	});
	if (result.exitCode !== 0) fail(`images_pixels.py ${args[0]} falhou`);
	const output = result.stdout.toString().trim();
	return output ? JSON.parse(output) : undefined;
}

function postsOfDay(postsDir: string, date: string, slug: string) {
	if (!existsSync(postsDir)) return [];
	return readdirSync(postsDir).filter(
		(name) => name.startsWith(`${date}-`) && name !== `${date}-${slug}`,
	);
}

function mfluxVersion() {
	const result = Bun.spawnSync(["uv", "tool", "list"], { stderr: "ignore" });
	return result.stdout.toString().match(/^mflux v(\S+)/m)?.[1] ?? "unknown";
}

// ---------------------------------------------------------------------------- brief

function brief(project: string, requestFile: string) {
	const ctx = projectContext(project);
	const request = readJson<Request>(requestFile);
	const count = validateRequest(request, ctx.assets);
	const references = requestReferences(request, ctx.assets);
	const aspect: Aspect =
		request.format === "story" ? "story" : (request.aspect ?? "feed");
	const read = (path?: string) =>
		path
			? readFileSync(path, "utf8").trim()
			: "(o projeto não tem este arquivo)";
	const history = existsSync(join(ctx.dir, "posts"))
		? readdirSync(join(ctx.dir, "posts")).sort().slice(-10)
		: [];
	console.log(`# Brief de imagens — projeto ${project}

Pedido: ${request.format}, ${count} imagem(ns), ${ASPECTS[aspect].width}x${ASPECTS[aspect].height}
Ideia: ${request.idea}
Pilar: ${request.pillar}

## Contexto
${read(ctx.context)}

## Persona
${read(ctx.persona)}

## Campanha (campaign.md)
${read(ctx.campaign)}

${
	ctx.direction.template
		? `## Modelo de prompt da campanha (a cena entra no lugar de [CENA])\n${ctx.direction.template}`
		: `## Estilo que o script acrescenta a todo prompt (da direção visual)\n${ctx.direction.style}`
}

## Referências reais que vão junto (assets/)
${references.length ? references.map((name) => `- assets/${name}`).join("\n") : "- nenhuma: a imagem não pode mostrar tela, logo ou produto inventado"}

## Últimos posts deste projeto
${history.map((name) => `- ${name}`).join("\n") || "- nenhum"}

## O que escrever
Preencha \`images\` no pedido com ${count} objeto(s) { "scene": "..." }, em inglês, uma cena por imagem:
- descreva só a cena (assunto, ação, enquadramento, luz); o estilo acima e a regra de "sem texto" o script acrescenta;
- a mensagem vai na legenda: nada de texto, número ou título dentro da imagem;${
		references.length
			? '\n- com referências, diga onde o produto entra ("the app icon from the reference image as a glossy 3D object on a desk"), sem descrever a aparência dele;'
			: ""
	}${request.format === "carousel" ? "\n- carrossel: as cenas contam uma sequência no mesmo cenário/estilo; o script repete seeds e referências em todos os slides." : ""}
Depois: bun marketing/instagram/scripts/images.ts generate ${project} ${relative(process.cwd(), requestFile)}`);
}

// ---------------------------------------------------------------------------- generate

async function generate(
	project: string,
	requestFile: string,
	options: { variations?: string; force?: boolean },
) {
	const ctx = projectContext(project);
	const request = readJson<Request>(requestFile);
	const count = validateRequest(request, ctx.assets);
	const references = requestReferences(request, ctx.assets);
	const images = request.images ?? [];
	if (images.length !== count || images.some((image) => !image.scene?.trim())) {
		fail(
			`o pedido precisa de ${count} imagem(ns) com \`scene\` escrita; rode \`brief\` e preencha \`images\``,
		);
	}

	const variationCount = Number(options.variations ?? request.variations ?? 3);
	if (
		!Number.isInteger(variationCount) ||
		variationCount < 1 ||
		variationCount > 8
	)
		fail("variations deve ser de 1 a 8");
	const aspect: Aspect =
		request.format === "story" ? "story" : (request.aspect ?? "feed");
	const dimensions = ASPECTS[aspect];
	const date = request.date ?? today();
	const slug = request.slug ? slugify(request.slug) : slugify(request.idea);
	const postsDir = join(ctx.dir, "posts");
	const others = postsOfDay(postsDir, date, slug);
	if (others.length >= MAX_POSTS_PER_DAY) {
		fail(
			`o projeto ${project} já tem ${others.length} posts em ${date} (${others.join(", ")}); o limite é ${MAX_POSTS_PER_DAY} por dia`,
		);
	}
	const dir = join(postsDir, `${date}-${slug}`);
	if (existsSync(dir) && !options.force)
		fail(`${relative(process.cwd(), dir)} já existe; use --force para refazer`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "prompts"), { recursive: true });
	const rawDir = join(dir, ".raw");
	mkdirSync(rawDir, { recursive: true });

	// The same seeds on every slide: variation vN of a carousel is one coherent set.
	const seeds =
		request.seeds?.slice(0, variationCount) ??
		Array.from({ length: variationCount }, () => randomInt(1, 1_000_000_000));
	if (seeds.length < variationCount)
		fail(
			`o pedido traz ${seeds.length} seeds para ${variationCount} variações`,
		);
	const referencePaths = references.map((name) =>
		join(ctx.dir, "assets", name),
	);
	const command = executable(
		references.length ? "mflux-generate-flux2-edit" : "mflux-generate-flux2",
	);

	const generated: GeneratedImage[] = [];
	for (const [index, image] of images.entries()) {
		const n = String(index + 1).padStart(2, "0");
		const scene = image.scene?.trim() ?? "";
		const slide =
			request.format === "carousel"
				? { n: index + 1, total: count }
				: undefined;
		const prompt = buildPrompt(
			scene,
			ctx.direction,
			aspect,
			references.length > 0,
			slide,
		);
		const promptFile = join(dir, "prompts", `${n}.txt`);
		writeFileSync(promptFile, `${prompt}\n`);
		const variations: Variation[] = [];
		for (const [i, seed] of seeds.entries()) {
			const id = `v${i + 1}`;
			const png = join(rawDir, `${n}-${id}.png`);
			// One process per variation: loading the model costs ~7 s, and a variation that dies
			// (memory pressure) does not take the others with it.
			// biome-ignore format: flag/value pairs
			const args = [
				"--model", MODEL.name,
				...(MODEL.quantize ? ["--quantize", String(MODEL.quantize)] : []),
				"--steps", String(MODEL.steps),
				"--guidance", String(MODEL.guidance),
				"--width", String(dimensions.generation[0]),
				"--height", String(dimensions.generation[1]),
				"--prompt-file", relative(ROOT, promptFile),
				"--seed", String(seed),
				...(referencePaths.length ? ["--image-paths", ...referencePaths.map((path) => relative(ROOT, path))] : []),
				"--output", relative(ROOT, png),
			]
			let seconds = 0;
			for (let attempt = 1; ; attempt++) {
				console.log(
					`\n▶ imagem ${n}/${String(count).padStart(2, "0")}, variação ${id} (seed ${seed})${attempt > 1 ? ", nova tentativa" : ""}`,
				);
				const start = performance.now();
				const child = Bun.spawn([command, ...args], {
					cwd: ROOT,
					stdout: "inherit",
					stderr: "inherit",
				});
				// mflux exits with 0 even when it aborts the generation; the file is the proof.
				const ok = (await child.exited) === 0 && existsSync(png);
				seconds = Math.round((performance.now() - start) / 100) / 10;
				if (ok) break;
				if (attempt === 2)
					fail(
						`mflux não gerou ${relative(process.cwd(), png)} (veja o log acima)`,
					);
			}
			const file = `${n}-${id}.jpg`;
			const { quality } = pixels(
				"finalize",
				png,
				join(dir, file),
				String(dimensions.width),
				String(dimensions.height),
			);
			variations.push({
				id,
				seed,
				file,
				bytes: statSync(join(dir, file)).size,
				jpegQuality: quality,
				seconds,
				command: [basename(command), ...args],
			});
			console.log(`✓ ${n}-${id}: ${seconds}s`);
		}
		generated.push({
			n,
			scene,
			prompt,
			promptFile: relative(dir, promptFile),
			variations,
		});
	}
	rmSync(rawDir, { recursive: true, force: true });

	const post = {
		project,
		slug,
		date,
		idea: request.idea,
		pillar: request.pillar,
		format: request.format,
		count,
		aspect,
		dimensions: {
			width: dimensions.width,
			height: dimensions.height,
			generation: dimensions.generation,
		},
		model: { ...MODEL, mflux: mfluxVersion(), cwd: "marketing/instagram" },
		sources: Object.fromEntries(
			[ctx.campaign, ctx.persona, ctx.context, ...referencePaths]
				.filter((path): path is string => Boolean(path))
				.map((path) => [relative(ctx.dir, path), hash(path)]),
		),
		visualDirection: ctx.direction.style,
		references: references.map((name) => `assets/${name}`),
		seeds,
		images: generated,
		generatedAt: new Date().toISOString(),
		review: null,
	};
	writeJson(join(dir, "post.json"), post);
	console.log(
		`\nPost salvo em ${relative(process.cwd(), dir)}\nRevisão: bun marketing/instagram/scripts/images.ts review ${project} ${relative(process.cwd(), dir)}`,
	);
}

// ---------------------------------------------------------------------------- review / choose

function readPost(project: string, postDir: string) {
	const ctx = projectContext(project);
	const dir = resolve(postDir);
	if (!dir.startsWith(`${join(ctx.dir, "posts")}/`))
		fail(`${postDir} não é um post do projeto ${project}`);
	const post = readJson<{
		project: string;
		format: Format;
		dimensions: { width: number; height: number };
		seeds: number[];
		images: GeneratedImage[];
		review: unknown;
		[key: string]: unknown;
	}>(join(dir, "post.json"));
	if (post.project !== project)
		fail(`o post é do projeto ${post.project}, não de ${project}`);
	return { ctx, dir, post };
}

function review(project: string, postDir: string) {
	const { ctx, dir, post } = readPost(project, postDir);
	const items = post.images.flatMap((image) =>
		image.variations.map(
			(variation) =>
				`${image.n}-${variation.id} · seed ${variation.seed}=${join(dir, variation.file)}`,
		),
	);
	const sheet = join(dir, "contact-sheet.jpg");
	pixels(
		"sheet",
		sheet,
		`${project} · ${basename(dir)} · linhas = imagens, colunas = variações`,
		String(post.seeds.length),
		...items,
	);
	console.log(`# Revisão — ${basename(dir)}

Folha de contato: ${relative(process.cwd(), sheet)}
Abra também cada variação em tamanho real:
${post.images.flatMap((image) => image.variations.map((v) => `- ${relative(process.cwd(), join(dir, v.file))}`)).join("\n")}
${post.references && (post.references as string[]).length ? `\nCompare com as referências reais:\n${(post.references as string[]).map((r) => `- ${relative(process.cwd(), join(ctx.dir, r))}`).join("\n")}\n` : ""}
Descarte a variação que:
- distorce o produto (forma, cor, logo ou tela diferentes da referência, ou produto inventado);
- traz texto, letras, números ou marcas d'água;
- foge da direção visual: ${ctx.direction.style}
- tem defeito visível (mãos, rostos, objetos derretidos, recorte ruim na proporção ${post.dimensions.width}x${post.dimensions.height}).
${post.format === "carousel" ? "Carrossel: prefira o mesmo vN em todos os slides (mesma seed = mesma continuidade).\n" : ""}
Depois: bun marketing/instagram/scripts/images.ts choose ${project} ${relative(process.cwd(), dir)} --pick v2 --reason "..." [--reject "01-v1=motivo"]`);
}

function choose(
	project: string,
	postDir: string,
	options: { pick?: string; reason?: string; reject?: string[] },
) {
	const { dir, post } = readPost(project, postDir);
	if (!options.pick) fail('falta --pick (ex.: "v2" ou "01=v2,02=v2,03=v1")');
	if (!options.reason?.trim()) fail("falta --reason");

	// "v2" applies to every image; "01=v2,02=v3" picks per image.
	const perImage = new Map<string, string>();
	if (/^v\d+$/.test(options.pick)) {
		for (const image of post.images) perImage.set(image.n, options.pick);
	} else {
		for (const pair of options.pick.split(",")) {
			const [n, id] = pair.split("=").map((part) => part.trim());
			perImage.set(n.padStart(2, "0"), id);
		}
	}
	const rejected = (options.reject ?? []).map((item) => {
		const [id, ...reason] = item.split("=");
		if (!/^\d{2}-v\d+$/.test(id) || !reason.join("=").trim())
			fail(`--reject "${item}" deve ser "01-v1=motivo"`);
		return { id, reason: reason.join("=").trim() };
	});

	mkdirSync(join(dir, "final"), { recursive: true });
	const chosen = post.images.map((image) => {
		const id = perImage.get(image.n);
		const variation = image.variations.find((v) => v.id === id);
		if (!variation)
			fail(`imagem ${image.n}: variação ${id ?? "(nenhuma)"} não existe`);
		if (rejected.some((r) => r.id === `${image.n}-${variation.id}`))
			fail(
				`${image.n}-${variation.id} foi escolhida e descartada ao mesmo tempo`,
			);
		const target = join(dir, "final", `${image.n}.jpg`);
		copyFileSync(join(dir, variation.file), target);
		const check = pixels("verify", target);
		const problems = [
			check.format !== "JPEG" && "não é JPEG",
			(check.width !== post.dimensions.width ||
				check.height !== post.dimensions.height) &&
				`tem ${check.width}x${check.height}`,
			!/srgb/i.test(check.icc ?? "") && `perfil ${check.icc ?? "ausente"}`,
			check.bytes >= 8 * 1024 * 1024 && "passa de 8 MB",
		].filter(Boolean);
		if (problems.length) fail(`final/${image.n}.jpg ${problems.join(", ")}`);
		return {
			n: image.n,
			variation: variation.id,
			seed: variation.seed,
			file: `final/${image.n}.jpg`,
			bytes: check.bytes,
		};
	});

	post.review = {
		chosen,
		reason: options.reason.trim(),
		rejected,
		reviewedAt: new Date().toISOString(),
	};
	writeJson(join(dir, "post.json"), post);
	console.log(
		`Escolha registrada em ${relative(process.cwd(), join(dir, "post.json"))}:`,
	);
	for (const c of chosen)
		console.log(
			`- ${c.file} ← ${c.n}-${c.variation} (seed ${c.seed}, ${Math.round(c.bytes / 1024)} KB)`,
		);
}

// ---------------------------------------------------------------------------- cli

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		variations: { type: "string" },
		force: { type: "boolean" },
		pick: { type: "string" },
		reason: { type: "string" },
		reject: { type: "string", multiple: true },
	},
});
const [action, project, target] = positionals;
if (!action || !project || !target)
	fail(
		"uso: images.ts <brief|generate|review|choose> <project> <request.json|post-dir> [opções]",
	);
switch (action) {
	case "brief":
		brief(project, resolve(target));
		break;
	case "generate":
		await generate(project, resolve(target), values);
		break;
	case "review":
		review(project, target);
		break;
	case "choose":
		choose(project, target, values);
		break;
	default:
		fail(`ação desconhecida: ${action}`);
}
