#!/usr/bin/env bun
/**
 * One Composio action on the project's own accounts: read comments, reply, read and answer
 * messages, react, read insights. Publishing is not here; it goes through publishing.ts, which
 * holds the approval and the daily cap.
 *
 *   bun scripts/social.ts <project> <SLUG> ['<json args>'] [--write]
 *
 * - The account comes from projects/<project>/publishing.json (instagram/facebook.composioAccount),
 *   so a project never acts on another project's account.
 * - "$pageId" and "$igUserId" in the arguments are replaced with the project's ids.
 * - Read actions (GET_/LIST_/FETCH_/SEARCH_) run as they are. Any other action changes something
 *   public (comment, reply, like, message) and needs --write, which the agent passes only when
 *   the user asked for that act.
 * - Each run is recorded in projects/<project>/composio-calls.jsonl, for usage.ts.
 * Output: the action's data as JSON on stdout.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ComposioError, createComposio } from "./composio";
import { loadSecrets } from "./secrets";
import { countCalls, newCallCount, recordPublishingCalls } from "./usage";

loadSecrets();

const ROOT = resolve(import.meta.dir, "..");

/** Actions that publish, schedule, delete posts or change the Page: only publishing.ts, or not at all. */
const REFUSED: Record<string, string> = {
	INSTAGRAM_POST_IG_USER_MEDIA: "publique com publishing.ts",
	INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: "publique com publishing.ts",
	INSTAGRAM_CREATE_CAROUSEL_CONTAINER: "publique com publishing.ts",
	FACEBOOK_CREATE_POST: "publique com publishing.ts",
	FACEBOOK_CREATE_PHOTO_POST: "publique com publishing.ts",
	FACEBOOK_CREATE_MULTI_PHOTO_POST: "publique com publishing.ts",
	FACEBOOK_CREATE_VIDEO_POST: "publique com publishing.ts",
	FACEBOOK_UPLOAD_PHOTOS_BATCH: "publique com publishing.ts",
	FACEBOOK_PUBLISH_SCHEDULED_POST: "publique com publishing.ts",
	FACEBOOK_RESCHEDULE_POST: "agende com publishing.ts publish --reschedule",
	FACEBOOK_UPDATE_POST: "um post publicado não é editado por aqui",
	FACEBOOK_DELETE_POST: "remova com publishing.ts remove",
	FACEBOOK_UPDATE_PAGE_SETTINGS: "administração da Página fica com o usuário",
	FACEBOOK_ASSIGN_PAGE_TASK: "administração da Página fica com o usuário",
	FACEBOOK_REMOVE_PAGE_TASK: "administração da Página fica com o usuário",
	INSTAGRAM_ENABLE_WEBHOOK_SUBSCRIPTIONS: "sem triggers no Composio; não serve",
	INSTAGRAM_CREATE_MEDIA_CONTAINER: "deprecada; publique com publishing.ts",
	INSTAGRAM_CREATE_POST: "deprecada; publique com publishing.ts",
	INSTAGRAM_GET_POST_COMMENTS: "deprecada; use INSTAGRAM_GET_IG_MEDIA_COMMENTS",
	INSTAGRAM_GET_POST_INSIGHTS: "deprecada; use INSTAGRAM_GET_IG_MEDIA_INSIGHTS",
	INSTAGRAM_GET_POST_STATUS: "deprecada",
	INSTAGRAM_GET_USER_MEDIA: "deprecada; use INSTAGRAM_GET_IG_USER_MEDIA",
	INSTAGRAM_REPLY_TO_COMMENT:
		"deprecada; use INSTAGRAM_POST_IG_COMMENT_REPLIES",
};

const READ = /^(INSTAGRAM|FACEBOOK)_(GET|LIST|FETCH|SEARCH)_/;

type ProjectAccounts = {
	instagram?: { composioAccount?: string | null; igUserId?: string | null };
	facebook?: { composioAccount?: string | null; pageId?: string | null };
};

function fail(message: string): never {
	console.error(`erro: ${message}`);
	process.exit(1);
}

/** Replaces "$pageId" / "$igUserId" string values, anywhere in the arguments. */
function fillIds(
	value: unknown,
	ids: Record<string, string | null | undefined>,
): unknown {
	if (Array.isArray(value)) return value.map((item) => fillIds(item, ids));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, fillIds(v, ids)]),
		);
	if (
		typeof value === "string" &&
		value.startsWith("$") &&
		value.slice(1) in ids
	) {
		const id = ids[value.slice(1)];
		if (!id) fail(`${value} não está em publishing.json deste projeto`);
		return id;
	}
	return value;
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { write: { type: "boolean", default: false } },
});
const [project, slug, rawArgs] = positionals;
if (!project || !slug)
	fail("uso: social.ts <project> <SLUG> ['<json args>'] [--write]");
if (!/^[a-z0-9][a-z0-9-]*$/.test(project))
	fail(`nome de projeto inválido: ${project}`);
const projectDir = join(ROOT, "projects", project);
const configPath = join(projectDir, "publishing.json");
if (!existsSync(configPath))
	fail(
		`projects/${project}/publishing.json não existe; crie com "publishing.ts init ${project}"`,
	);
const config = JSON.parse(readFileSync(configPath, "utf8")) as ProjectAccounts;

const toolkit = slug.startsWith("INSTAGRAM_")
	? "instagram"
	: slug.startsWith("FACEBOOK_")
		? "facebook"
		: undefined;
if (!toolkit)
	fail(
		`${slug}: só ações INSTAGRAM_* e FACEBOOK_*; as meta tools (COMPOSIO_*) não passam por aqui`,
	);
if (REFUSED[slug]) fail(`${slug} recusada: ${REFUSED[slug]}`);
if (toolkit === "instagram" && !config.instagram?.igUserId)
	fail(
		`o Instagram não está conectado no projeto ${project} (instagram.igUserId é null). Pare e avise o usuário: quem conecta é ele, em composio.dev → For You; depois rode "publishing.ts connection ${project} --save".`,
	);
if (!READ.test(slug) && !values.write)
	fail(
		`${slug} muda algo público; rode de novo com --write só se o usuário pediu esse ato`,
	);

let args: unknown = {};
if (rawArgs) {
	try {
		args = JSON.parse(rawArgs);
	} catch {
		fail(`os argumentos não são JSON: ${rawArgs}`);
	}
}
args = fillIds(args, {
	pageId: config.facebook?.pageId,
	igUserId: config.instagram?.igUserId,
});

const calls = newCallCount();
const composio = countCalls(createComposio(), calls);
process.on("exit", () => {
	if (calls.total === 0) return;
	recordPublishingCalls(projectDir, {
		at: new Date().toISOString(),
		command: "social",
		composioCalls: calls,
	});
});

try {
	const data = await composio.execute(
		slug,
		args as Record<string, unknown>,
		config[toolkit]?.composioAccount,
	);
	console.log(JSON.stringify(data, null, "\t"));
} catch (error) {
	fail(error instanceof ComposioError ? error.message : String(error));
}
