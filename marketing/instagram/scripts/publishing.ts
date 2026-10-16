#!/usr/bin/env bun
/**
 * Publishing flow: from an item of the project's calendar to the post going live.
 *
 *   bun scripts/publishing.ts init       <project>
 *   bun scripts/publishing.ts connection <project> [--save] [--page "<name>"]
 *   bun scripts/publishing.ts calendar   <project> [--date YYYY-MM-DD]
 *   bun scripts/publishing.ts draft      <project> <request.json>
 *   bun scripts/publishing.ts caption    <project> <post-dir>
 *   bun scripts/publishing.ts host       <project> <post-dir>
 *   bun scripts/publishing.ts question   <project> <post-dir>
 *   bun scripts/publishing.ts decision   <project> <post-dir> <answer> [--comment "..."]
 *   bun scripts/publishing.ts redo       <project> <post-dir> [--request new.json] [--caption-only]
 *   bun scripts/publishing.ts quota      <project> [--at YYYY-MM-DDTHH:MM]
 *   bun scripts/publishing.ts publish    <project> <post-dir> [--at YYYY-MM-DDTHH:MM] [--reschedule] [--facebook-only]
 *   bun scripts/publishing.ts remove     <project> <post-dir>
 *   bun scripts/publishing.ts status     <project> <post-dir>
 *
 * Everything starts from the selected project: the config (projects/<project>/publishing.json),
 * the caption rules, the connected accounts and the history that counts toward the daily cap
 * belong to it, and a post folder outside projects/<project>/posts/ is refused. Keys come from
 * ~/.config/cline-marketing/instagram.env (see secrets.ts).
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
import { type Composio, createComposio, findField } from "./composio";
import {
	analyzeCaption,
	applyDecision,
	type CaptionRules,
	calendarItems,
	fitsInWindow,
	localInstant,
	nextFreeDay,
	type PublishingState,
	parseDecision,
	stripAccents,
} from "./publishing-rules";
import { loadSecrets } from "./secrets";
import {
	type CallCount,
	countCalls,
	newCallCount,
	recordPublishingCalls,
} from "./usage";

loadSecrets();

const ROOT = resolve(import.meta.dir, "..");
const IMAGES = join(import.meta.dir, "images.ts");
const UPLOAD = join(import.meta.dir, "upload-image.ts");
/** Button labels of the approval question: user-facing, so in Portuguese. */
const APPROVAL_OPTIONS = ["Aprovar", "Pedir ajuste", "Descartar"] as const;

type Config = {
	timezone: string;
	/** Fixed offset of the timezone, to read "YYYY-MM-DDTHH:MM" (Brazil has no daylight saving). */
	utcOffset: string;
	dailyLimit: number;
	instagram: {
		composioAccount?: string | null;
		igUserId?: string | null;
		username?: string | null;
	};
	facebook?: {
		mirror: boolean;
		composioAccount?: string | null;
		pageId?: string | null;
		name?: string | null;
	};
	caption: CaptionRules;
	captionFacebook?: CaptionRules;
};

type Media = { file: string; url: string; uploadedAt: string };

type Publishing = {
	state: PublishingState;
	round: number;
	request: Record<string, unknown>;
	caption?: {
		file: string;
		text: string;
		hashtags: string[];
		cta?: string;
		checkedAt: string;
	};
	captionFacebook?: { file: string; text: string; checkedAt: string };
	media?: Media[];
	question?: { askedAt: string; round: number };
	approvals: {
		round: number;
		decision: string;
		comment?: string;
		at: string;
	}[];
	scheduledFor?: string;
	quota?: Record<string, unknown>;
	instagram?: {
		igUserId: string;
		containers: string[];
		creationId: string;
		mediaId?: string;
		permalink?: string;
		publishedAt?: string;
		publishedCaption?: string;
	};
	facebook?: {
		pageId: string;
		postId?: string;
		permalink?: string;
		publishedAt?: string;
		error?: string;
	};
	removedAt?: string;
	history: { at: string; event: string; detail?: string }[];
};

type Post = {
	project: string;
	slug: string;
	date: string;
	format: "post" | "carousel" | "story";
	count: number;
	review: null | { chosen: { n: string; file: string }[] };
	publishing?: Publishing;
	[key: string]: unknown;
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

const now = () => new Date().toISOString();
const rel = (path: string) => relative(process.cwd(), path) || ".";

function projectDir(project: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
		fail(`nome de projeto inválido: ${project}`);
	const dir = join(ROOT, "projects", project);
	if (!existsSync(dir)) fail(`projeto não existe: ${rel(dir)}`);
	return dir;
}

function readConfig(project: string): Config {
	const path = join(projectDir(project), "publishing.json");
	if (!existsSync(path)) {
		fail(
			`${rel(path)} não existe; crie com "publishing.ts init ${project}" e preencha as contas com "connection ${project} --save"`,
		);
	}
	return readJson<Config>(path);
}

function saveConfig(project: string, config: Config) {
	writeJson(join(projectDir(project), "publishing.json"), config);
}

/** Opens a post of the project. A folder of another project is refused, even if it exists. */
function openPost(project: string, postDir: string) {
	const posts = join(projectDir(project), "posts");
	const dir = resolve(postDir);
	if (!dir.startsWith(`${posts}/`)) {
		fail(
			`${rel(dir)} não é um post do projeto ${project} (${rel(posts)}/<data>-<slug>)`,
		);
	}
	const path = join(dir, "post.json");
	const post = readJson<Post>(path);
	if (post.project !== project)
		fail(`${rel(path)} é do projeto ${post.project}`);
	return {
		dir,
		post,
		save: () => writeJson(path, post),
	};
}

function publishingOf(post: Post): Publishing {
	if (!post.publishing) {
		fail(
			`o post ${post.slug} não entrou no fluxo; crie com "publishing.ts draft"`,
		);
	}
	return post.publishing;
}

function logEvent(pub: Publishing, event: string, detail?: string) {
	pub.history.push({ at: now(), event, ...(detail ? { detail } : {}) });
}

/**
 * Every Composio client of this command counts its calls in a single count. On exit, even
 * through `fail`, the command records the total in projects/<project>/composio-calls.jsonl,
 * which is where usage.ts sums up the publishing flow.
 */
const composioCalls: CallCount = newCallCount();
let commandRecord:
	| { projectDir: string; command: string; post?: string }
	| undefined;

function countedComposio(): Composio {
	return countCalls(createComposio(), composioCalls);
}

process.on("exit", () => {
	const meta = Object.keys(composioCalls.metaTools ?? {}).length;
	if (!commandRecord || (composioCalls.total === 0 && meta === 0)) return;
	recordPublishingCalls(commandRecord.projectDir, {
		at: now(),
		command: commandRecord.command,
		...(commandRecord.post ? { post: commandRecord.post } : {}),
		composioCalls,
	});
});

function requireState(pub: Publishing, ...accepted: PublishingState[]) {
	if (!accepted.includes(pub.state)) {
		fail(
			`o post está em "${pub.state}"; este passo exige ${accepted.map((s) => `"${s}"`).join(" ou ")}`,
		);
	}
}

function run(args: string[], options?: { capture?: boolean }) {
	const r = Bun.spawnSync(["bun", ...args], {
		cwd: ROOT,
		stdout: options?.capture ? "pipe" : "inherit",
		stderr: "inherit",
		env: process.env,
	});
	if (r.exitCode !== 0)
		fail(
			`"bun ${args.map((a) => relative(ROOT, a) || a).join(" ")}" saiu com ${r.exitCode}`,
		);
	return options?.capture ? (r.stdout?.toString() ?? "").trim() : "";
}

// ---------------------------------------------------------------------------------------------
// Init

/**
 * The project's publishing.json, before any account is known. Ids stay null: only
 * `connection --save` fills them, from what Composio returns, so a project never starts with
 * another project's accounts. The caption rules start empty and must come from campaign.md.
 */
function initialConfig(): Config {
	const emptyRules = (): CaptionRules => ({
		maxWords: 120,
		maxEmojis: 2,
		maxChars: 2200,
		hashtags: { min: 3, max: 5, required: [], allowed: [], forbidden: [] },
		forbiddenTerms: [],
		ctas: [],
	});
	return {
		timezone: "America/Sao_Paulo",
		utcOffset: "-03:00",
		dailyLimit: 3,
		instagram: { composioAccount: null, igUserId: null, username: null },
		facebook: { mirror: true, composioAccount: null, pageId: null, name: null },
		caption: emptyRules(),
		captionFacebook: {
			...emptyRules(),
			hashtags: { min: 1, max: 2, required: [], allowed: [], forbidden: [] },
		},
	};
}

function init(project: string) {
	const dir = projectDir(project);
	const path = join(dir, "publishing.json");
	if (existsSync(path))
		fail(`${rel(path)} já existe; ele não é recriado (edite ou apague antes)`);
	if (!existsSync(join(dir, "campaign.md")))
		fail(
			`o projeto ${project} não tem campaign.md; as regras de legenda saem dele`,
		);
	writeJson(path, initialConfig());
	console.log(`Criado ${rel(path)}, com as contas em null.
Próximos passos:
  1. bun scripts/publishing.ts connection ${project}                       # só lê: contas e Páginas que o Composio enxerga
  2. bun scripts/publishing.ts connection ${project} --save --page "<nome>"  # grava composioAccount, igUserId, username e pageId
  3. Preencha caption e captionFacebook (hashtags, forbiddenTerms, ctas, link) a partir de campaign.md
  4. Ajuste timezone, utcOffset e dailyLimit se o projeto não for de São Paulo ou tiver outro teto`);
}

// ---------------------------------------------------------------------------------------------
// Connection

/** Instagram account and Meta limit, for `connection`. */
async function readInstagram(composio: Composio, config: Config) {
	const igAccount = config.instagram.composioAccount;
	const info = await composio.execute(
		"INSTAGRAM_GET_USER_INFO",
		{
			ig_user_id: config.instagram.igUserId ?? "me",
			fields:
				"id,user_id,username,name,account_type,media_count,followers_count",
		},
		igAccount,
	);
	const igUserId = String(findField(info, "id") ?? "");
	const username = String(findField(info, "username") ?? "");
	const accountType = findField(info, "account_type");
	if (!igUserId)
		fail(
			`INSTAGRAM_GET_USER_INFO não devolveu id: ${JSON.stringify(info).slice(0, 400)}`,
		);
	console.log(
		`Instagram: @${username} · id ${igUserId} · tipo ${accountType ?? "?"}`,
	);
	const limit = await composio.execute(
		"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		{ ig_user_id: igUserId, fields: "quota_usage,config" },
		igAccount,
	);
	console.log(
		`Limite da Meta: ${findField(limit, "quota_usage") ?? "?"} de ${findField(limit, "quota_total") ?? "?"} em 24h`,
	);
	return { igUserId, username };
}

/**
 * Checks what the project will use: the active connections in Composio, the Instagram account
 * (@, type, ig_user_id), the Meta limit and the Page. The account has more than one Page, so
 * the project's is the one already pinned, the one linked to Instagram or the one `--page`
 * names; never a guess.
 */
async function connection(
	project: string,
	options: { save: boolean; page?: string },
) {
	const config = readConfig(project);
	const composio = countedComposio();
	const summary = await composio.connections(["instagram", "facebook"]);
	console.log(
		`Conexões: ${JSON.stringify(findField(summary, "summary") ?? summary).slice(0, 600)}`,
	);
	// Without an active connection the first action fails with a generic Composio error; say which is missing.
	const results = (findField(summary, "results") ?? {}) as Record<
		string,
		{ status?: string; accounts?: { status?: string }[] } | undefined
	>;
	const missing = ["instagram", "facebook"].filter((tk) => {
		const r = results[tk];
		return r
			? r.status !== "active" && !r.accounts?.some((c) => c.status === "active")
			: findField(summary, "active_connections") === 0;
	});
	// Without Instagram the Page still publishes (publish --facebook-only); without Facebook there is nothing to do.
	if (missing.includes("facebook")) {
		fail(
			`sem conexão ativa no Composio para ${missing.join(" e ")}; conclua a autorização em composio.dev → For You e rode de novo`,
		);
	}
	const hasInstagram = !missing.includes("instagram");
	if (!hasInstagram) {
		console.warn(
			"aviso: sem conexão ativa no Composio para instagram; seguindo só com a Página (publish --facebook-only)",
		);
	}
	const ig = hasInstagram ? await readInstagram(composio, config) : undefined;
	const igUserId = ig?.igUserId ?? config.instagram.igUserId;

	const pages = await composio.execute(
		"FACEBOOK_LIST_MANAGED_PAGES",
		{ fields: "id,name,tasks,instagram_business_account", limit: 50 },
		config.facebook?.composioAccount,
	);
	const list = findField(pages, "data") ?? pages;
	const items = (Array.isArray(list) ? list : []) as Record<string, unknown>[];
	const linkedIg = (p: Record<string, unknown>) =>
		(p.instagram_business_account as { id?: string } | undefined)?.id;
	for (const p of items) {
		console.log(
			`Página: ${p.name} · id ${p.id}${linkedIg(p) ? ` · ligada ao IG ${linkedIg(p)}` : ""}`,
		);
	}
	const chosen =
		items.find((p) => String(p.id) === config.facebook?.pageId) ??
		(igUserId ? items.find((p) => linkedIg(p) === igUserId) : undefined) ??
		(options.page
			? items.find(
					(p) =>
						stripAccents(String(p.name ?? "")) ===
						stripAccents(options.page as string),
				)
			: undefined);
	if (options.page && !chosen)
		fail(`nenhuma Página se chama "${options.page}"`);
	console.log(
		chosen
			? `Página do projeto: ${chosen.name} (${chosen.id})`
			: 'Página do projeto: nenhuma fixada; use --page "<nome>" com --save',
	);

	if (options.save) {
		if (ig) config.instagram = { ...config.instagram, ...ig };
		if (chosen) {
			config.facebook = {
				mirror: config.facebook?.mirror ?? true,
				composioAccount: config.facebook?.composioAccount ?? null,
				pageId: String(chosen.id),
				name: String(chosen.name ?? ""),
			};
		}
		saveConfig(project, config);
		console.log(
			`Salvo em ${rel(join(projectDir(project), "publishing.json"))}`,
		);
	}
}

// ---------------------------------------------------------------------------------------------
// Calendar

/** Rows of the project's campaign calendar table, with the date already as YYYY-MM-DD. */
function readCalendar(project: string, year: number) {
	const campaign = readFileSync(
		join(projectDir(project), "campaign.md"),
		"utf8",
	);
	const items = calendarItems(campaign, year);
	if (!items)
		fail(`projects/${project}/campaign.md não tem a seção de calendário`);
	return items;
}

// ---------------------------------------------------------------------------------------------
// Draft

function readRequest(path: string) {
	const request = readJson<Record<string, unknown>>(resolve(path));
	if (request.format === "story") {
		fail("stories ficam fora desta fase: o fluxo publica post e carrossel");
	}
	if (typeof request.slug !== "string" || typeof request.date !== "string") {
		fail(
			"o pedido precisa de `slug` e `date` (AAAA-MM-DD), para a pasta do post ser previsível",
		);
	}
	return request;
}

/**
 * Which images.ts action makes the post's images: `generate` when the request describes scenes
 * for mflux, `import` when it points at ready images (card attachment, file or URL).
 */
function imageAction(request: Record<string, unknown>) {
	const images = Array.isArray(request.images)
		? (request.images as { scene?: unknown; source?: unknown }[])
		: [];
	const sources = images.filter(
		(i) => typeof i.source === "string" && i.source.trim(),
	).length;
	const scenes = images.filter(
		(i) => typeof i.scene === "string" && i.scene.trim(),
	).length;
	if (sources && scenes)
		fail(
			"o pedido mistura `scene` e `source`; use um ou outro em todas as imagens",
		);
	return sources ? "import" : "generate";
}

function requestDir(project: string, request: Record<string, unknown>) {
	return join(projectDir(project), "posts", `${request.date}-${request.slug}`);
}

/** Makes the images with the project's engine (images.ts generate or import) and puts the post in the flow. */
function draft(project: string, requestFile: string) {
	const request = readRequest(requestFile);
	const dir = requestDir(project, request);
	if (existsSync(join(dir, "post.json"))) {
		fail(`${rel(dir)} já existe; para refazer use "publishing.ts redo"`);
	}
	if (!existsSync(IMAGES))
		fail(`motor de imagens não encontrado: ${rel(IMAGES)}`);
	const action = imageAction(request);
	run([IMAGES, action, project, resolve(requestFile)]);
	const { post, save } = openPost(project, dir);
	post.publishing = {
		state: "draft",
		round: 1,
		request,
		approvals: [],
		history: [],
	};
	logEvent(post.publishing, "draft", "rodada 1");
	save();
	console.log(
		action === "import"
			? `\nRascunho em ${rel(dir)}. Próximo: conferir final/, escrever caption.txt.`
			: `\nRascunho em ${rel(dir)}. Próximo: revisar e escolher as variações (images.ts review/choose), escrever caption.txt.`,
	);
}

/**
 * Change request: redoes the images (with the new request, if the comment changed the scene)
 * or just the caption, keeping what the flow already knows. The image engine wipes the folder
 * when redoing, so the flow state is kept before and restored after.
 */
function redo(
	project: string,
	postDir: string,
	options: { request?: string; captionOnly: boolean },
) {
	const { dir, post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	requireState(pub, "changes_requested");
	const previous = { ...pub };
	if (!options.captionOnly) {
		const request = options.request
			? readRequest(options.request)
			: pub.request;
		if (`${request.date}-${request.slug}` !== basename(dir)) {
			fail(
				`o pedido novo aponta para ${request.date}-${request.slug}; mantenha date e slug de ${basename(dir)}`,
			);
		}
		const tempFile = join(
			mkdtempSync(join(tmpdir(), "publishing-")),
			"request.json",
		);
		writeJson(tempFile, request);
		run([IMAGES, imageAction(request), project, tempFile, "--force"]);
		const reopened = openPost(project, dir);
		reopened.post.publishing = {
			...previous,
			request,
			state: "draft",
			round: previous.round + 1,
			media: undefined,
			question: undefined,
		};
		logEvent(
			reopened.post.publishing,
			"redo",
			`rodada ${previous.round + 1}: imagens refeitas`,
		);
		reopened.save();
	} else {
		pub.state = "draft";
		pub.round += 1;
		pub.caption = undefined;
		pub.captionFacebook = undefined;
		pub.question = undefined;
		logEvent(pub, "redo", `rodada ${pub.round}: só a legenda`);
		save();
	}
	console.log(`Rodada ${previous.round + 1} aberta em ${rel(dir)}.`);
}

function checkCaption(file: string, rules: CaptionRules, name: string) {
	if (!existsSync(file)) fail(`falta ${rel(file)}`);
	const analysis = analyzeCaption(readFileSync(file, "utf8"), rules);
	if (analysis.problems.length) {
		console.error(`${name} fora das regras do projeto:`);
		for (const p of analysis.problems)
			console.error(`  - ${p.rule}: ${p.detail}`);
		process.exit(1);
	}
	return analysis;
}

function caption(project: string, postDir: string) {
	const config = readConfig(project);
	const { dir, post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	requireState(pub, "draft");
	const ig = checkCaption(
		join(dir, "caption.txt"),
		config.caption,
		"caption.txt",
	);
	pub.caption = {
		file: "caption.txt",
		text: ig.text,
		hashtags: ig.hashtags,
		cta: ig.cta,
		checkedAt: now(),
	};
	console.log(
		`caption.txt ok: ${ig.words} palavras, ${ig.hashtags.length} hashtags, CTA "${ig.cta ?? "-"}"`,
	);
	if (config.facebook?.mirror && config.captionFacebook) {
		const fb = checkCaption(
			join(dir, "caption-facebook.txt"),
			config.captionFacebook,
			"caption-facebook.txt",
		);
		pub.captionFacebook = {
			file: "caption-facebook.txt",
			text: fb.text,
			checkedAt: now(),
		};
		console.log(
			`caption-facebook.txt ok: ${fb.words} palavras, ${fb.hashtags.length} hashtags`,
		);
	}
	logEvent(pub, "caption", ig.cta);
	save();
}

function host(project: string, postDir: string) {
	const { dir, post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	requireState(pub, "draft");
	const chosen = post.review?.chosen ?? [];
	if (!chosen.length)
		fail("nenhuma variação escolhida; rode images.ts choose antes");
	if (post.format === "carousel" && (chosen.length < 2 || chosen.length > 10)) {
		fail(`um carrossel tem de 2 a 10 imagens; este tem ${chosen.length}`);
	}
	if (!existsSync(UPLOAD))
		fail(`script de hospedagem não encontrado: ${rel(UPLOAD)}`);
	pub.media = chosen.map((c) => {
		const url =
			run([UPLOAD, join(dir, c.file), "--check"], { capture: true })
				.split("\n")
				.pop() ?? "";
		if (!/^https:\/\//.test(url))
			fail(`o upload de ${c.file} não devolveu uma URL https: "${url}"`);
		console.log(`${c.file} → ${url}`);
		return { file: c.file, url, uploadedAt: now() };
	});
	logEvent(pub, "hosted", `${pub.media.length} imagem(ns)`);
	save();
}

/**
 * The question the card's agent asks with AskUserQuestion. The images go as Markdown with an
 * absolute path: Kanban pulls them out of the text and the Telegram connector sends them as
 * photos, with the buttons below.
 */
function question(project: string, postDir: string) {
	const config = readConfig(project);
	const { dir, post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	requireState(pub, "draft", "awaiting_approval");
	if (!pub.caption)
		fail('a legenda ainda não foi conferida; rode "publishing.ts caption"');
	if (
		config.facebook?.mirror &&
		config.captionFacebook &&
		!pub.captionFacebook
	) {
		fail("falta conferir caption-facebook.txt");
	}
	if (!pub.media?.length)
		fail('as imagens ainda não têm URL pública; rode "publishing.ts host"');
	const destination = [
		`Instagram${config.instagram.username ? ` @${config.instagram.username}` : ""}`,
		config.facebook?.mirror && config.facebook.pageId
			? `Página ${config.facebook.name ?? config.facebook.pageId}`
			: undefined,
	]
		.filter(Boolean)
		.join(" + ");
	const lastChangeRequest = pub.approvals
		.filter((a) => a.decision === "request_changes")
		.at(-1);
	const text = [
		`Aprovar o post ${post.slug} (${post.date}, ${post.format}${post.format === "carousel" ? ` de ${pub.media.length}` : ""}, rodada ${pub.round}) para ${destination}?`,
		lastChangeRequest?.comment
			? `Ajuste pedido: ${lastChangeRequest.comment}`
			: undefined,
		`Legenda:\n${pub.caption.text}`,
		pub.media.map((m) => `![${m.file}](${join(dir, m.file)})`).join(" "),
	]
		.filter(Boolean)
		.join("\n\n");
	pub.state = "awaiting_approval";
	pub.question = { askedAt: now(), round: pub.round };
	logEvent(pub, "question", `rodada ${pub.round}`);
	save();
	console.log(
		JSON.stringify(
			{
				questions: [
					{
						question: text,
						header: "Aprovação",
						multiSelect: false,
						options: [
							{
								label: APPROVAL_OPTIONS[0],
								description: "Publica agora, se couber no limite do dia",
							},
							{
								label: APPROVAL_OPTIONS[1],
								description: "Volta ao rascunho com o seu comentário",
							},
							{
								label: APPROVAL_OPTIONS[2],
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

function decision(
	project: string,
	postDir: string,
	answer: string,
	comment?: string,
) {
	const { post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	const choice = parseDecision(answer);
	if (!choice)
		fail(`resposta "${answer}" não é ${APPROVAL_OPTIONS.join(" / ")}`);
	if (choice === "request_changes" && !comment?.trim()) {
		fail('"Pedir ajuste" precisa de --comment com o que mudar');
	}
	try {
		pub.state = applyDecision(pub.state, choice);
	} catch (error) {
		fail((error as Error).message);
	}
	pub.approvals.push({
		round: pub.round,
		decision: choice,
		...(comment?.trim() ? { comment: comment.trim() } : {}),
		at: now(),
	});
	logEvent(pub, choice, comment?.trim());
	save();
	console.log(`Post ${post.slug}: ${pub.state}.`);
}

// ---------------------------------------------------------------------------------------------
// Daily cap and publishing

/** Project posts that take up the cap: published and scheduled ones, except this one. */
function takenSlots(project: string, except?: string) {
	const posts = join(projectDir(project), "posts");
	if (!existsSync(posts)) return [];
	return readdirSync(posts).flatMap((name) => {
		const path = join(posts, name, "post.json");
		if (name === except || !existsSync(path)) return [];
		const pub = readJson<Post>(path).publishing;
		const when =
			pub?.state === "published"
				? (pub.instagram?.publishedAt ?? pub.facebook?.publishedAt)
				: pub?.state === "scheduled"
					? pub.scheduledFor
					: undefined;
		return when
			? [{ post: name, state: pub?.state, at: Date.parse(when) }]
			: [];
	});
}

function targetOf(config: Config, at?: string) {
	return at ? localInstant(at, config.utcOffset) : Date.now();
}

function local(config: Config, t: number) {
	return new Date(t).toLocaleString("pt-BR", { timeZone: config.timezone });
}

function quota(project: string, at?: string) {
	const config = readConfig(project);
	const target = targetOf(config, at);
	const taken = takenSlots(project);
	const { fits, count } = fitsInWindow(
		target,
		taken.map((o) => o.at),
		config.dailyLimit,
	);
	console.log(
		`${project} · ${local(config, target)} · ${count} publicação(ões) na janela de 24h · limite ${config.dailyLimit}`,
	);
	for (const o of taken.filter(
		(o) => Math.abs(o.at - target) < 24 * 3600_000,
	)) {
		console.log(`  - ${o.post} (${o.state} ${local(config, o.at)})`);
	}
	if (!fits) {
		const next = nextFreeDay(
			target,
			taken.map((o) => o.at),
			config.dailyLimit,
		);
		console.log(
			`Não cabe. Próximo dia livre: ${next ? local(config, next) : "nenhum em 30 dias"}`,
		);
		process.exit(2);
	}
	console.log("Cabe.");
}

async function publish(
	project: string,
	postDir: string,
	options: { at?: string; reschedule: boolean; facebookOnly: boolean },
) {
	const config = readConfig(project);
	const { dir, post, save } = openPost(project, postDir);
	const pub = publishingOf(post);

	// --facebook-only on an already published post redoes just the mirror on the Page.
	if (options.facebookOnly && pub.state === "published") {
		await mirrorToFacebook(countedComposio(), config, pub);
		save();
		return;
	}
	requireState(pub, "approved", "scheduled");
	if (
		!pub.approvals.some(
			(a) => a.decision === "approve" && a.round === pub.round,
		)
	) {
		fail(`a rodada ${pub.round} não foi aprovada`);
	}
	if (!pub.caption || !pub.media?.length)
		fail("falta legenda ou mídia hospedada");
	if (post.format === "carousel" && pub.media.length < 2)
		fail("carrossel com menos de 2 imagens");

	const target = options.at ? targetOf(config, options.at) : Date.now();
	if (
		pub.state === "scheduled" &&
		pub.scheduledFor &&
		Date.parse(pub.scheduledFor) > target
	) {
		fail(
			`agendado para ${local(config, Date.parse(pub.scheduledFor))}; rode de novo a partir daí`,
		);
	}

	// 1. Project cap: published and scheduled posts, in a 24h window.
	const taken = takenSlots(project, basename(dir));
	const capWindow = fitsInWindow(
		Date.now(),
		taken.map((o) => o.at),
		config.dailyLimit,
	);
	pub.quota = {
		checkedAt: now(),
		project: { count: capWindow.count, limit: config.dailyLimit },
	};
	if (!capWindow.fits) {
		const next = nextFreeDay(
			Date.now(),
			taken.map((o) => o.at),
			config.dailyLimit,
		);
		if (options.reschedule && next) {
			pub.state = "scheduled";
			pub.scheduledFor = new Date(next).toISOString();
			logEvent(
				pub,
				"scheduled",
				`teto de ${config.dailyLimit}/dia atingido; empurrado para ${local(config, next)}`,
			);
			save();
			console.log(
				`Teto do projeto atingido (${capWindow.count}/${config.dailyLimit}). Agendado para ${local(config, next)}: rode "publish" de novo nesse horário.`,
			);
			return;
		}
		logEvent(pub, "refused", `teto de ${config.dailyLimit}/dia atingido`);
		save();
		fail(
			`o projeto já tem ${capWindow.count} publicações na janela de 24h (limite ${config.dailyLimit}). Próximo dia livre: ${next ? local(config, next) : "nenhum"}. Use --reschedule para agendar.`,
		);
	}

	// --facebook-only on an approved post publishes only on the Page (Instagram may not even be
	// connected). It went through the same gates: the round's approval and the project cap.
	if (options.facebookOnly) {
		if (!config.facebook?.pageId)
			fail(
				'o projeto não fixou a Página; rode "connection --save --page "<nome>""',
			);
		await mirrorToFacebook(countedComposio(), config, pub, {
			pageOnly: { save },
		});
		pub.state = "published";
		pub.scheduledFor = undefined;
		logEvent(pub, "published", `só na Página ${pub.facebook?.permalink ?? ""}`);
		save();
		return;
	}

	// 2. Account and Meta limit (content_publishing_limit).
	// The client is only created here: what the project refuses needs neither the key nor the network.
	const composio = countedComposio();
	const igAccount = config.instagram.composioAccount;
	const igUserId = config.instagram.igUserId;
	if (!igUserId)
		fail(
			'o projeto não fixou a conta do Instagram; rode "connection --save", ou publique só na Página com --facebook-only',
		);
	const metaLimit = await composio.execute(
		"INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
		{ ig_user_id: igUserId, fields: "quota_usage,config" },
		igAccount,
	);
	const used = Number(findField(metaLimit, "quota_usage") ?? Number.NaN);
	const total = Number(findField(metaLimit, "quota_total") ?? Number.NaN);
	pub.quota.meta = { quota_usage: used, quota_total: total };
	if (Number.isNaN(used)) {
		fail(
			`não consegui ler o content_publishing_limit: ${JSON.stringify(metaLimit).slice(0, 400)}`,
		);
	}
	if (!Number.isNaN(total) && used >= total) {
		logEvent(pub, "refused", `limite da Meta ${used}/${total}`);
		save();
		fail(
			`a conta já usou ${used} de ${total} publicações pela API nas últimas 24h`,
		);
	}
	console.log(
		`Teto do projeto ${capWindow.count}/${config.dailyLimit} · limite da Meta ${used}/${Number.isNaN(total) ? "?" : total}`,
	);

	// 3. Container and publish. The whole carousel is a single container (the slides go through
	// child_image_urls) and a single publish. The publish waits for the container to be ready.
	const igCaption = pub.caption.text;
	const container =
		post.format === "carousel"
			? await composio.execute(
					"INSTAGRAM_CREATE_CAROUSEL_CONTAINER",
					{
						ig_user_id: igUserId,
						child_image_urls: pub.media.map((m) => m.url),
						caption: igCaption,
					},
					igAccount,
				)
			: await composio.execute(
					"INSTAGRAM_POST_IG_USER_MEDIA",
					{
						ig_user_id: igUserId,
						image_url: pub.media[0].url,
						caption: igCaption,
					},
					igAccount,
				);
	const creationId = String(findField(container, "id") ?? "");
	if (!creationId)
		fail(
			`o container não voltou com id: ${JSON.stringify(container).slice(0, 400)}`,
		);
	const children = findField(container, "children");
	pub.instagram = {
		igUserId,
		creationId,
		containers: Array.isArray(children)
			? children.map((c) => String((c as { id?: string }).id ?? c))
			: [],
	};
	logEvent(pub, "container", creationId);
	save();

	const published = await composio.execute(
		"INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
		{ ig_user_id: igUserId, creation_id: creationId, max_wait_seconds: 120 },
		igAccount,
	);
	const mediaId = String(findField(published, "id") ?? "");
	if (!mediaId)
		fail(
			`publicado sem media id na resposta: ${JSON.stringify(published).slice(0, 400)}`,
		);
	const media = await composio.execute(
		"INSTAGRAM_GET_IG_MEDIA",
		{
			ig_media_id: mediaId,
			fields: "id,permalink,timestamp,caption,media_type",
		},
		igAccount,
	);
	pub.instagram.mediaId = mediaId;
	pub.instagram.permalink = String(findField(media, "permalink") ?? "");
	pub.instagram.publishedAt = String(findField(media, "timestamp") ?? now());
	pub.instagram.publishedCaption = String(findField(media, "caption") ?? "");
	pub.state = "published";
	pub.scheduledFor = undefined;
	logEvent(pub, "published", `${mediaId} ${pub.instagram.permalink}`);
	save();
	console.log(`Instagram: media ${mediaId} · ${pub.instagram.permalink}`);
	if (pub.instagram.publishedCaption.trim() !== igCaption.trim()) {
		console.warn(
			"aviso: a legenda publicada difere da aprovada; confira o post (hashtags e quebras de linha)",
		);
	}

	// 4. Facebook Page, when the project mirrors. Failing here does not undo Instagram.
	await mirrorToFacebook(composio, config, pub);
	save();
}

async function mirrorToFacebook(
	composio: Composio,
	config: Config,
	pub: Publishing,
	/** pageOnly: the post goes only to the Page; a failure saves the error with `save` and exits. */
	options: { pageOnly?: { save: () => void } } = {},
) {
	const fb = config.facebook;
	if (!fb?.pageId || (!fb.mirror && !options.pageOnly)) return;
	if (pub.facebook?.postId) {
		console.log(`Facebook já publicado: ${pub.facebook.postId}`);
		return;
	}
	const message = pub.captionFacebook?.text ?? pub.caption?.text ?? "";
	const urls = (pub.media ?? []).map((m) => m.url);
	try {
		const response =
			urls.length > 1
				? await composio.execute(
						"FACEBOOK_CREATE_MULTI_PHOTO_POST",
						{ page_id: fb.pageId, message, photo_urls: urls },
						fb.composioAccount,
					)
				: await composio.execute(
						"FACEBOOK_CREATE_PHOTO_POST",
						{
							page_id: fb.pageId,
							url: urls[0],
							message,
							published: true,
						},
						fb.composioAccount,
					);
		const postId = String(
			findField(response, "post_id") ?? findField(response, "id") ?? "",
		);
		if (!postId)
			throw new Error(`sem post id: ${JSON.stringify(response).slice(0, 300)}`);
		const details = await composio.execute(
			"FACEBOOK_GET_POST",
			{ post_id: postId, fields: "id,permalink_url,created_time" },
			fb.composioAccount,
		);
		pub.facebook = {
			pageId: fb.pageId,
			postId,
			permalink: String(findField(details, "permalink_url") ?? ""),
			publishedAt: String(findField(details, "created_time") ?? now()),
		};
		logEvent(pub, "facebook", `${postId} ${pub.facebook.permalink}`);
		console.log(`Facebook: post ${postId} · ${pub.facebook.permalink}`);
	} catch (error) {
		const errorMessage = (error as Error).message;
		pub.facebook = { pageId: fb.pageId, error: errorMessage };
		logEvent(pub, "facebook_failed", errorMessage);
		// Page only: failing here is failing the publish, and the post stays approved.
		if (options.pageOnly) {
			options.pageOnly.save();
			fail(`a Página não publicou: ${errorMessage}`);
		}
		console.error(
			`aviso: Instagram publicado, Página não: ${errorMessage}. Tente de novo com --facebook-only.`,
		);
	}
}

/**
 * For the test post. The Page deletes through the API; Instagram has no action to delete media
 * (neither in the Graph API nor in Composio), so there the post is deleted by hand in the app
 * and this command only records it.
 */
async function remove(project: string, postDir: string) {
	const config = readConfig(project);
	const { post, save } = openPost(project, postDir);
	const pub = publishingOf(post);
	requireState(pub, "published");
	if (pub.facebook?.postId) {
		await countedComposio().execute(
			"FACEBOOK_DELETE_POST",
			{ post_id: pub.facebook.postId },
			config.facebook?.composioAccount,
		);
		console.log(`Facebook: post ${pub.facebook.postId} apagado.`);
	}
	pub.state = "removed";
	pub.removedAt = now();
	// A post published only on the Page has nothing to delete on Instagram.
	logEvent(
		pub,
		"removed",
		pub.instagram ? "Instagram: apagar à mão no app" : "só na Página",
	);
	save();
	if (pub.instagram) {
		console.log(
			`Instagram: apague à mão ${pub.instagram.permalink ?? "(sem permalink)"} (Mais opções → Excluir).`,
		);
	}
}

function status(project: string, postDir: string) {
	const { post } = openPost(project, postDir);
	const pub = publishingOf(post);
	console.log(
		JSON.stringify(
			{
				slug: post.slug,
				date: post.date,
				format: post.format,
				...pub,
				request: undefined,
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
		save: { type: "boolean", default: false },
		page: { type: "string" },
		date: { type: "string" },
		comment: { type: "string" },
		request: { type: "string" },
		"caption-only": { type: "boolean", default: false },
		at: { type: "string" },
		reschedule: { type: "boolean", default: false },
		"facebook-only": { type: "boolean", default: false },
	},
});
const [command, project, target, answer] = positionals;
if (!command || !project) {
	fail(
		"uso: publishing.ts <init|connection|calendar|draft|caption|host|question|decision|redo|quota|publish|remove|status> <project> …",
	);
}
const required = (value: string | undefined, name: string) =>
	value ?? fail(`falta ${name}`);
if (["connection", "publish", "remove"].includes(command)) {
	commandRecord = {
		projectDir: projectDir(project),
		command,
		...(command !== "connection" && target
			? { post: basename(resolve(target)) }
			: {}),
	};
}

switch (command) {
	case "init":
		init(project);
		break;
	case "connection":
		await connection(project, { save: values.save, page: values.page });
		break;
	case "calendar": {
		const year = Number((values.date ?? new Date().toISOString()).slice(0, 4));
		const items = readCalendar(project, year).filter(
			(i) => !values.date || i.date === values.date,
		);
		console.log(JSON.stringify(items, null, "\t"));
		break;
	}
	case "draft":
		draft(project, required(target, "<request.json>"));
		break;
	case "caption":
		caption(project, required(target, "<post-dir>"));
		break;
	case "host":
		host(project, required(target, "<post-dir>"));
		break;
	case "question":
		question(project, required(target, "<post-dir>"));
		break;
	case "decision":
		decision(
			project,
			required(target, "<post-dir>"),
			required(answer, "<answer>"),
			values.comment,
		);
		break;
	case "redo":
		redo(project, required(target, "<post-dir>"), {
			request: values.request,
			captionOnly: values["caption-only"],
		});
		break;
	case "quota":
		quota(project, values.at);
		break;
	case "publish":
		await publish(project, required(target, "<post-dir>"), {
			at: values.at,
			reschedule: values.reschedule,
			facebookOnly: values["facebook-only"],
		});
		break;
	case "remove":
		await remove(project, required(target, "<post-dir>"));
		break;
	case "status":
		status(project, required(target, "<post-dir>"));
		break;
	default:
		fail(`comando desconhecido: ${command}`);
}
