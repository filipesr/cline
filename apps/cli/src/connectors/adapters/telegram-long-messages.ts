import { markdownToFormattable } from "@gramio/format/markdown";
import type { AdapterPostableMessage, FileUpload } from "chat";
import {
	buildTelegramDocumentCaption,
	buildTelegramDocumentName,
	buildTelegramPreview,
	TELEGRAM_LONG_TEXT_LIMIT,
} from "./telegram-format";

const FILE_ABOVE_NOTE = "(texto completo no arquivo acima)";

/**
 * The text of a message too long for the chat, or nothing when it fits or is not plain text.
 *
 * The Telegram adapter does not split a long message: it truncates it at 4096 characters
 * with an ellipsis, so a card's report or a command's answer simply lost its end. Well
 * before that a message is a wall nobody reads, so past `TELEGRAM_LONG_TEXT_LIMIT` it goes
 * out as a file. A message
 * that already carries files or a card is left alone -- it has a shape of its own to keep.
 */
export function readOverflowingTelegramText(
	message: AdapterPostableMessage,
): string | undefined {
	if (typeof message === "string") {
		return message.length > TELEGRAM_LONG_TEXT_LIMIT ? message : undefined;
	}
	if (!message || typeof message !== "object") {
		return undefined;
	}
	if ("files" in message && (message.files?.length ?? 0) > 0) {
		return undefined;
	}
	if ("attachments" in message && (message.attachments?.length ?? 0) > 0) {
		return undefined;
	}
	if ("raw" in message && typeof message.raw === "string") {
		return message.raw.length > TELEGRAM_LONG_TEXT_LIMIT
			? message.raw
			: undefined;
	}
	if ("markdown" in message && typeof message.markdown === "string") {
		// Measured as Telegram shows it: markup characters do not count against the limit.
		const shown = markdownToFormattable(message.markdown).text;
		return shown.length > TELEGRAM_LONG_TEXT_LIMIT
			? message.markdown
			: undefined;
	}
	return undefined;
}

/** The whole text as a `.md` file, under a caption with its end. */
export function asTelegramDocumentPostable(
	text: string,
	now: Date,
): { raw: string; files: FileUpload[] } {
	return {
		raw: buildTelegramDocumentCaption(text),
		files: [
			{
				data: Buffer.from(text, "utf8"),
				filename: buildTelegramDocumentName(text, now),
				mimeType: "text/markdown",
			},
		],
	};
}

/**
 * What stays in a message that must remain a message -- one with buttons, or one edited
 * later -- once its full text has gone out as a file just before it.
 */
export function buildTelegramShortPreview(text: string): string {
	return buildTelegramPreview(text, TELEGRAM_LONG_TEXT_LIMIT, FILE_ABOVE_NOTE);
}

type PostingAdapter<TResult> = {
	postMessage(
		threadId: string,
		message: AdapterPostableMessage,
	): Promise<TResult>;
};

/**
 * Every message the connector posts through the library -- command answers, `/task` and
 * card notices, scheduled results, task updates -- goes out as a `.md` file when it would
 * not fit. One place, so no path is left cutting text. A refused file falls back to the
 * message as it was: cut by the adapter, but delivered.
 */
export function sendLongMessagesAsDocuments<TResult>(
	adapter: PostingAdapter<TResult>,
	now: () => Date = () => new Date(),
): void {
	const post = adapter.postMessage.bind(adapter);
	adapter.postMessage = async (threadId, message) => {
		const text = readOverflowingTelegramText(message);
		if (text === undefined) {
			return await post(threadId, message);
		}
		try {
			return await post(threadId, asTelegramDocumentPostable(text, now()));
		} catch {
			return await post(threadId, message);
		}
	};
}

/**
 * A card notice cannot simply become a file: its buttons hang off it, and a tap edits it
 * afterwards. So the full text goes first as a file, and the notice stays a message carrying
 * its end -- the question its buttons answer. Buttons, replies and edits work on it as before.
 */
export function splitLongCardNotice(
	text: string,
	now: Date,
): { text: string; document?: { raw: string; files: FileUpload[] } } {
	if (readOverflowingTelegramText({ markdown: text }) === undefined) {
		return { text };
	}
	return {
		text: buildTelegramShortPreview(text),
		document: asTelegramDocumentPostable(text, now),
	};
}

/** Room left for a status line's detail beside the card's title and id. */
const STATUS_DETAIL_LIMIT = TELEGRAM_LONG_TEXT_LIMIT - 200;

/**
 * The card's running status line is edited in place every few seconds, and a file cannot be
 * edited as a message. So instead of going out as a file, its detail keeps only its end --
 * the latest of what the agent is doing.
 */
export function clipStatusDetail(
	detail: string | undefined,
): string | undefined {
	if (!detail || detail.length <= STATUS_DETAIL_LIMIT) {
		return detail;
	}
	return `…${detail.slice(detail.length - (STATUS_DETAIL_LIMIT - 1)).trimStart()}`;
}
