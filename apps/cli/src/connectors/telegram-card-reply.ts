/**
 * Posting a card's messages as real Telegram replies, which the chat library cannot do.
 *
 * The adapter in use implements no `reply`: `reply_to_message_id` appears nowhere in its send
 * path, and asking the thread for a reply throws. Tying the messages with a line of text
 * instead was readable but not what a reply is -- there is no link to follow back to the card,
 * which was the point.
 *
 * So these two messages, and only these two, go straight to the Bot API. The rest of the
 * connector keeps using the library.
 *
 * What makes this safe is that a tap is routed from the update itself: the adapter reads the
 * chat, the message and the callback data off the incoming `callback_query` and never looks
 * the message up. A message posted here is therefore as answerable as one the library posted,
 * provided the two agree on how ids and callback data are written -- which is why both
 * encodings live here, named, instead of being spelled out at the call site.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { TelegramFormatConverter } from "@chat-adapter/telegram";

import type { CardButton } from "./card-question-message";

const markdown = new TelegramFormatConverter();

/**
 * A card's text as Telegram shows it. The agent's conclusion is markdown; sent as plain text its
 * **bold** and `code` arrived as literal asterisks and backticks. `plain` is the fallback for
 * markup Telegram cannot parse, such as a conclusion clipped in the middle of `**`.
 */
function renderText(
	text: string,
	plain: boolean,
): { text: string; parse_mode?: "MarkdownV2" } {
	return plain
		? { text }
		: { text: markdown.fromMarkdown(text), parse_mode: "MarkdownV2" };
}

interface TelegramResponse {
	ok?: boolean;
	description?: string;
	result?: { message_id?: number };
}

/** A file sent along with a message's text, which then becomes the file's caption. */
export interface CardReplyDocument {
	data: string;
	filename: string;
}

/** A picture read off disk, ready to upload. */
export interface CardReplyPhoto {
	data: Uint8Array;
	filename: string;
	mimeType: string;
}

/** One uploaded file in a multipart body, under the field the Bot API reads it from. */
interface FormFile {
	field: string;
	blob: Blob;
	filename: string;
}

function documentFile(document: CardReplyDocument): FormFile {
	return {
		field: "document",
		blob: new Blob([document.data], { type: "text/markdown;charset=utf-8" }),
		filename: document.filename,
	};
}

function photoFile(field: string, photo: CardReplyPhoto): FormFile {
	return {
		field,
		blob: new Blob([new Uint8Array(photo.data)], { type: photo.mimeType }),
		filename: photo.filename,
	};
}

/**
 * A multipart body, which is the only way to upload a file. Its fields are strings, so the
 * nested ones -- the reply target, the keyboard -- travel as JSON, as the Bot API expects.
 */
function toFormData(
	body: Record<string, unknown>,
	files: readonly FormFile[],
): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(body)) {
		form.append(
			key,
			typeof value === "object" ? JSON.stringify(value) : String(value),
		);
	}
	for (const file of files) {
		form.append(file.field, file.blob, file.filename);
	}
	return form;
}

/**
 * Calls the Bot API with the text rendered as markdown, and once more as plain text when Telegram
 * refuses the markup -- losing the notice over a stray asterisk would be worse than showing it.
 */
async function callWithMarkdownFallback(input: {
	botToken: string;
	method:
		| "sendMessage"
		| "sendDocument"
		| "sendPhoto"
		| "sendMediaGroup"
		| "editMessageText"
		| "editMessageCaption";
	buildBody: (plain: boolean) => Record<string, unknown>;
	files?: readonly FormFile[];
	fetchImpl?: typeof fetch;
}): Promise<TelegramResponse> {
	const call = input.fetchImpl ?? fetch;
	const send = async (plain: boolean): Promise<TelegramResponse> => {
		const body = input.buildBody(plain);
		const response = await call(
			`https://api.telegram.org/bot${input.botToken}/${input.method}`,
			input.files && input.files.length > 0
				? { method: "POST", body: toFormData(body, input.files) }
				: {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
		);
		return (await response.json()) as TelegramResponse;
	};
	const rendered = await send(false);
	if (
		!rendered.ok &&
		/can't parse entities/i.test(rendered.description ?? "")
	) {
		return await send(true);
	}
	return rendered;
}

export interface TelegramMessageRef {
	chatId: string;
	messageId: string;
}

/**
 * Splits the composite id the adapter hands out (`-1001234:567`) back into its parts.
 *
 * A chat id is negative for a group, so the split is on the last separator rather than the
 * first: `-1004378402573:358` is chat `-1004378402573`, message `358`.
 */
export function splitTelegramMessageId(
	compositeId: string,
): TelegramMessageRef | undefined {
	const separator = compositeId.lastIndexOf(":");
	if (separator <= 0) {
		return undefined;
	}
	const chatId = compositeId.slice(0, separator);
	const messageId = compositeId.slice(separator + 1);
	if (!chatId || !/^\d+$/.test(messageId)) {
		return undefined;
	}
	return { chatId, messageId };
}

/** Joins them back the way the adapter does, so a remembered id matches an incoming tap. */
export function joinTelegramMessageId(
	chatId: string,
	messageId: number | string,
): string {
	return `${chatId}:${messageId}`;
}

export interface CardReplyRequest {
	/** Where to post: the group, and the forum topic inside it when there is one. */
	chatId: string;
	messageThreadId?: string;
	/** The card's anchor, which this message replies to. */
	replyToMessageId: string;
	text: string;
	/** The buttons, in order, each carrying its own callback data. Empty means no keyboard. */
	buttons: readonly CardButton[];
	/**
	 * The notice's full text as a file, when it is too long to read in the chat. Sent with the
	 * file, `text` is its caption: one message holding the file, the question and its buttons,
	 * where there used to be the file and then the question on its own.
	 */
	document?: CardReplyDocument;
	/**
	 * A picture the question is about, such as a draft to approve. Sent with it, `text` is its
	 * caption and the buttons sit under the picture. Never together with `document`: a message
	 * carries one file.
	 */
	photo?: CardReplyPhoto;
}

function buildInlineKeyboard(
	buttons: readonly CardButton[],
): Array<Array<{ text: string; callback_data: string }>> {
	return buttons.map((button) => [
		{ text: button.label, callback_data: button.actionId },
	]);
}

/** A message carrying a file has a caption where a text message has its text. */
function asCaptionWhen(
	caption: boolean,
	rendered: { text: string; parse_mode?: "MarkdownV2" },
): Record<string, string> {
	const { text, ...rest } = rendered;
	return caption ? { caption: text, ...rest } : { text, ...rest };
}

/**
 * The `sendMessage` body, or the `sendDocument` one when a file goes with it.
 *
 * `allow_sending_without_reply` matters: an anchor deleted by hand would otherwise make
 * Telegram refuse the whole message, and losing a question because the message it pointed at
 * is gone would leave the card waiting forever on an answer nobody was asked for.
 */
export function buildCardReplyBody(
	request: CardReplyRequest,
	options: { plain?: boolean } = {},
): Record<string, unknown> {
	const keyboard = buildInlineKeyboard(request.buttons);
	return {
		chat_id: request.chatId,
		...(request.messageThreadId
			? { message_thread_id: Number(request.messageThreadId) }
			: {}),
		...asCaptionWhen(
			request.document !== undefined || request.photo !== undefined,
			renderText(request.text, options.plain === true),
		),
		reply_parameters: {
			message_id: Number(request.replyToMessageId),
			allow_sending_without_reply: true,
		},
		...(keyboard.length > 0
			? { reply_markup: { inline_keyboard: keyboard } }
			: {}),
	};
}

export interface PostCardReplyResult {
	/** The new message, in the composite form the rest of the connector remembers ids in. */
	messageId: string;
}

/**
 * Sends it. Returns nothing when Telegram refuses, so the caller can fall back to posting
 * through the library rather than dropping the message.
 */
export async function postTelegramCardReply(input: {
	botToken: string;
	request: CardReplyRequest;
	fetchImpl?: typeof fetch;
}): Promise<PostCardReplyResult | undefined> {
	try {
		const payload = await callWithMarkdownFallback({
			botToken: input.botToken,
			method: input.request.photo
				? "sendPhoto"
				: input.request.document
					? "sendDocument"
					: "sendMessage",
			buildBody: (plain) => buildCardReplyBody(input.request, { plain }),
			files: input.request.photo
				? [photoFile("photo", input.request.photo)]
				: input.request.document
					? [documentFile(input.request.document)]
					: undefined,
			fetchImpl: input.fetchImpl,
		});
		if (!payload.ok || typeof payload.result?.message_id !== "number") {
			return undefined;
		}
		return {
			messageId: joinTelegramMessageId(
				input.request.chatId,
				payload.result.message_id,
			),
		};
	} catch {
		return undefined;
	}
}

/** Telegram refuses a photo upload larger than this. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const PHOTO_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

/**
 * Reads a notification's pictures off disk, in order. One that is missing, unreadable, too large
 * or not a picture is left out rather than failing the rest: the question matters more than any
 * one picture, and an empty result means it goes out as text, as it did before pictures.
 */
export async function loadCardPhotos(
	paths: readonly string[],
): Promise<CardReplyPhoto[]> {
	const photos: CardReplyPhoto[] = [];
	for (const path of paths) {
		const mimeType = PHOTO_MIME_TYPES[extname(path).toLowerCase()];
		if (!mimeType) {
			continue;
		}
		try {
			const info = await stat(path);
			if (!info.isFile() || info.size === 0 || info.size > MAX_PHOTO_BYTES) {
				continue;
			}
			photos.push({
				data: await readFile(path),
				filename: basename(path),
				mimeType,
			});
		} catch {
			// Gone or unreadable: skipped, like one that is too large.
		}
	}
	return photos;
}

/**
 * Posts pictures on their own as a reply to the card: one as a photo, several as an album. Used
 * when the pictures cannot carry the question -- an album takes no keyboard, and a question too
 * long for a caption goes out as a file -- so they arrive just before it. Reports whether
 * Telegram took them; the question is sent either way.
 */
export async function postTelegramCardPhotos(input: {
	botToken: string;
	chatId: string;
	messageThreadId?: string;
	replyToMessageId: string;
	photos: readonly CardReplyPhoto[];
	fetchImpl?: typeof fetch;
}): Promise<boolean> {
	if (input.photos.length === 0) {
		return false;
	}
	const target = {
		chat_id: input.chatId,
		...(input.messageThreadId
			? { message_thread_id: Number(input.messageThreadId) }
			: {}),
		reply_parameters: {
			message_id: Number(input.replyToMessageId),
			allow_sending_without_reply: true,
		},
	};
	const album = input.photos.length > 1;
	try {
		const payload = await callWithMarkdownFallback({
			botToken: input.botToken,
			method: album ? "sendMediaGroup" : "sendPhoto",
			// An album names each upload by its field: `attach://photo0` is the file sent as `photo0`.
			buildBody: () =>
				album
					? {
							...target,
							media: input.photos.map((_, index) => ({
								type: "photo",
								media: `attach://photo${index}`,
							})),
						}
					: target,
			files: album
				? input.photos.map((photo, index) => photoFile(`photo${index}`, photo))
				: [photoFile("photo", input.photos[0] as CardReplyPhoto)],
			fetchImpl: input.fetchImpl,
		});
		return payload.ok === true;
	} catch {
		return false;
	}
}

/**
 * The forum topic a thread lives in, read off the binding key the connector already uses.
 *
 * A key is `telegram:<chat>:<topic>` in a group with topics, and `telegram:<chat>` in a direct
 * message, where there is no topic to name.
 */
export function resolveTelegramTopicId(threadKey: string): string | undefined {
	const parts = threadKey.split(":");
	const topic = parts.length >= 3 ? parts[parts.length - 1] : undefined;
	return topic && /^\d+$/.test(topic) ? topic : undefined;
}

/**
 * Rewrites a message posted here, which is what removes its keyboard.
 *
 * `editMessageText` with no `reply_markup` clears the buttons, so an answered question stops
 * being answerable in the same call that marks what was chosen. Given `buttons`, the message is
 * rewritten with those instead -- a Concluir that would discard work asks on the same message.
 */
export async function editTelegramCardMessage(input: {
	botToken: string;
	messageRef: string;
	text: string;
	/** A new keyboard to show instead; without it the edit clears the buttons. */
	buttons?: readonly CardButton[];
	fetchImpl?: typeof fetch;
}): Promise<boolean> {
	const ref = splitTelegramMessageId(input.messageRef);
	if (!ref) {
		return false;
	}
	try {
		const edit = (caption: boolean) =>
			callWithMarkdownFallback({
				botToken: input.botToken,
				method: caption ? "editMessageCaption" : "editMessageText",
				buildBody: (plain) => ({
					chat_id: ref.chatId,
					message_id: Number(ref.messageId),
					...asCaptionWhen(caption, renderText(input.text, plain)),
					...(input.buttons && input.buttons.length > 0
						? {
								reply_markup: {
									inline_keyboard: buildInlineKeyboard(input.buttons),
								},
							}
						: {}),
				}),
				fetchImpl: input.fetchImpl,
			});
		const payload = await edit(false);
		// A notice sent with its file -- or with its picture -- is that file's caption. Telegram
		// says so rather than the connector remembering which messages carry one -- which a
		// restart would forget.
		if (
			!payload.ok &&
			/no text in the message to edit/i.test(payload.description ?? "")
		) {
			return (await edit(true)).ok === true;
		}
		return payload.ok === true;
	} catch {
		return false;
	}
}
