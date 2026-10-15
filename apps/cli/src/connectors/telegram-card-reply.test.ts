import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	buildCardReplyBody,
	editTelegramCardMessage,
	joinTelegramMessageId,
	loadCardPhotos,
	postTelegramCardPhotos,
	postTelegramCardReply,
	resolveTelegramTopicId,
	splitTelegramMessageId,
} from "./telegram-card-reply";

describe("splitTelegramMessageId", () => {
	it("splits the composite id a group message carries", () => {
		expect(splitTelegramMessageId("-1004378402573:358")).toEqual({
			chatId: "-1004378402573",
			messageId: "358",
		});
	});

	// Today's chat ids carry no separator of their own, so this case is defensive rather than
	// observed -- but the message number is always last, and reading the first separator would
	// one day send an edit to a chat that does not exist.
	it("takes the message number from the last separator, not the first", () => {
		expect(splitTelegramMessageId("-100:7:358")).toEqual({
			chatId: "-100:7",
			messageId: "358",
		});
	});

	it("refuses an id that is not one", () => {
		expect(splitTelegramMessageId("358")).toBeUndefined();
		expect(splitTelegramMessageId("-100:abc")).toBeUndefined();
		expect(splitTelegramMessageId(":358")).toBeUndefined();
	});

	it("round-trips with the way the adapter writes them", () => {
		expect(joinTelegramMessageId("-1004378402573", 358)).toBe(
			"-1004378402573:358",
		);
	});
});

describe("buildCardReplyBody", () => {
	it("replies to the anchor, inside the forum topic", () => {
		const body = buildCardReplyBody({
			chatId: "-1004378402573",
			messageThreadId: "49",
			replyToMessageId: "358",
			text: "Gravar?",
			buttons: [],
		});

		expect(body).toMatchObject({
			chat_id: "-1004378402573",
			message_thread_id: 49,
			text: "Gravar?",
			reply_parameters: { message_id: 358 },
		});
	});

	// An anchor deleted by hand would otherwise make Telegram refuse the whole message, and
	// the question would be lost rather than merely unanchored.
	it("still sends when the anchor is gone", () => {
		const body = buildCardReplyBody({
			chatId: "-100",
			replyToMessageId: "1",
			text: "Gravar?",
			buttons: [],
		});

		expect(body.reply_parameters).toMatchObject({
			allow_sending_without_reply: true,
		});
	});

	// The tap is routed from the callback data alone, so this has to carry the connector's own
	// action id or the answer reaches nothing.
	it("puts each option on a button carrying its action", () => {
		const body = buildCardReplyBody({
			chatId: "-100",
			replyToMessageId: "1",
			text: "Gravar?",
			buttons: [
				{ label: "Gravar", actionId: "kbq:a3ae5:1" },
				{ label: "Descartar", actionId: "kbq:a3ae5:2" },
			],
		});

		expect(body.reply_markup).toEqual({
			inline_keyboard: [
				[{ text: "Gravar", callback_data: "kbq:a3ae5:1" }],
				[{ text: "Descartar", callback_data: "kbq:a3ae5:2" }],
			],
		});
	});

	it("sends no keyboard when there is nothing to choose", () => {
		const body = buildCardReplyBody({
			chatId: "-100",
			replyToMessageId: "1",
			text: "Ready for review",
			buttons: [],
		});

		expect(body).not.toHaveProperty("reply_markup");
	});
});

describe("markdown in a card's messages", () => {
	// The agent's conclusion is markdown. Sent as plain text, its **bold** and `code` arrived
	// as literal asterisks and backticks and its lists as one run-on paragraph.
	it("renders the text as Telegram MarkdownV2", () => {
		const body = buildCardReplyBody({
			chatId: "-100",
			replyToMessageId: "1",
			text: "- **Hash:** `189af67`\n- **Stash:** não usado (ok).",
			buttons: [],
		});

		expect(body.parse_mode).toBe("MarkdownV2");
		expect(body.text).toBe(
			"\\- *Hash:* `189af67`\n\\- *Stash:* não usado \\(ok\\)\\.",
		);
	});

	it("can be built as plain text, for when Telegram refuses the markup", () => {
		const body = buildCardReplyBody(
			{
				chatId: "-100",
				replyToMessageId: "1",
				text: "**Hash:** `189af67`",
				buttons: [],
			},
			{ plain: true },
		);

		expect(body).not.toHaveProperty("parse_mode");
		expect(body.text).toBe("**Hash:** `189af67`");
	});

	// A conclusion clipped in the middle of `**` is markup Telegram cannot parse; losing the
	// whole notice over that would be worse than showing the asterisks.
	it("posts it plain when Telegram cannot parse the markup", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({
					ok: false,
					description: "Bad Request: can't parse entities: unclosed bold",
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true, result: { message_id: 401 } }),
			}) as unknown as typeof fetch;

		const result = await postTelegramCardReply({
			botToken: "token",
			fetchImpl,
			request: {
				chatId: "-100",
				replyToMessageId: "1",
				text: "**corte no meio",
				buttons: [],
			},
		});

		expect(result).toEqual({ messageId: "-100:401" });
		const retried = JSON.parse(
			String((vi.mocked(fetchImpl).mock.calls[1]?.[1] as RequestInit).body),
		);
		expect(retried).not.toHaveProperty("parse_mode");
		expect(retried.text).toBe("**corte no meio");
	});

	it("edits with markdown too, falling back the same way", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({
					ok: false,
					description: "Bad Request: can't parse entities",
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true }),
			}) as unknown as typeof fetch;

		const edited = await editTelegramCardMessage({
			botToken: "token",
			messageRef: "-100:400",
			text: "**Hash:** `abc`",
			fetchImpl,
		});

		expect(edited).toBe(true);
		const first = JSON.parse(
			String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(first.parse_mode).toBe("MarkdownV2");
		const second = JSON.parse(
			String((vi.mocked(fetchImpl).mock.calls[1]?.[1] as RequestInit).body),
		);
		expect(second).not.toHaveProperty("parse_mode");
	});
});

describe("postTelegramCardReply", () => {
	it("returns the new message in the form ids are remembered in", async () => {
		const fetchImpl = vi.fn(async () => ({
			json: async () => ({ ok: true, result: { message_id: 400 } }),
		})) as unknown as typeof fetch;

		const result = await postTelegramCardReply({
			botToken: "token",
			fetchImpl,
			request: {
				chatId: "-1004378402573",
				replyToMessageId: "358",
				text: "Gravar?",
				buttons: [],
			},
		});

		expect(result).toEqual({ messageId: "-1004378402573:400" });
	});

	// The caller falls back to the library on nothing, so a refusal must not look like success
	// and must not throw either.
	it("returns nothing when Telegram refuses", async () => {
		const fetchImpl = vi.fn(async () => ({
			json: async () => ({ ok: false, description: "chat not found" }),
		})) as unknown as typeof fetch;

		await expect(
			postTelegramCardReply({
				botToken: "token",
				fetchImpl,
				request: {
					chatId: "-100",
					replyToMessageId: "1",
					text: "Gravar?",
					buttons: [],
				},
			}),
		).resolves.toBeUndefined();
	});

	it("returns nothing when the call itself fails", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			postTelegramCardReply({
				botToken: "token",
				fetchImpl,
				request: {
					chatId: "-100",
					replyToMessageId: "1",
					text: "Gravar?",
					buttons: [],
				},
			}),
		).resolves.toBeUndefined();
	});
});

describe("resolveTelegramTopicId", () => {
	it("reads the forum topic off the binding key", () => {
		expect(resolveTelegramTopicId("telegram:-1004378402573:49")).toBe("49");
	});

	// A direct message has no topic, and guessing one would post into nowhere.
	it("finds none in a direct message", () => {
		expect(resolveTelegramTopicId("telegram:946217355")).toBeUndefined();
	});

	it("ignores a trailing part that is not a topic", () => {
		expect(resolveTelegramTopicId("telegram:-100:general")).toBeUndefined();
	});
});

describe("editTelegramCardMessage", () => {
	// Editing with no reply_markup is what clears the buttons, so an answered question stops
	// being answerable in the same call that marks what was chosen.
	it("rewrites the message without a keyboard", async () => {
		const fetchImpl = vi.fn(async () => ({
			json: async () => ({ ok: true }),
		})) as unknown as typeof fetch;

		const edited = await editTelegramCardMessage({
			botToken: "token",
			messageRef: "-1004378402573:400",
			text: "Gravar?\n\n✅ Descartar",
			fetchImpl,
		});

		expect(edited).toBe(true);
		const body = JSON.parse(
			String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body).toMatchObject({
			chat_id: "-1004378402573",
			message_id: 400,
			text: "Gravar?\n\n✅ Descartar",
		});
		expect(body).not.toHaveProperty("reply_markup");
	});

	// Concluir that would discard work asks first, on the same message: the rewrite has to
	// carry the confirmation's buttons instead of clearing them.
	it("rewrites the message with a new keyboard when given buttons", async () => {
		const fetchImpl = vi.fn(async () => ({
			json: async () => ({ ok: true }),
		})) as unknown as typeof fetch;

		await editTelegramCardMessage({
			botToken: "token",
			messageRef: "-1004378402573:400",
			text: "1 commit não integrado será descartado.",
			buttons: [
				{ label: "Concluir mesmo assim", actionId: "kba:52609:done!" },
				{ label: "Cancelar", actionId: "kba:52609:cancel" },
			],
			fetchImpl,
		});

		const body = JSON.parse(
			String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit).body),
		);
		expect(body.reply_markup).toEqual({
			inline_keyboard: [
				[{ text: "Concluir mesmo assim", callback_data: "kba:52609:done!" }],
				[{ text: "Cancelar", callback_data: "kba:52609:cancel" }],
			],
		});
	});

	it("reports failure instead of throwing", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			editTelegramCardMessage({
				botToken: "token",
				messageRef: "-100:1",
				text: "x",
				fetchImpl,
			}),
		).resolves.toBe(false);
	});
});

describe("a long card notice, sent with its file", () => {
	// Reported from use: a long question arrived as two messages -- the file, then the question
	// with its buttons. One message carries both: the file, with the question as its caption.
	it("posts the file and the notice as one message", async () => {
		const fetchImpl = vi.fn(async () => ({
			json: async () => ({ ok: true, result: { message_id: 402 } }),
		})) as unknown as typeof fetch;

		const result = await postTelegramCardReply({
			botToken: "token",
			fetchImpl,
			request: {
				chatId: "-1004378402573",
				messageThreadId: "49",
				replyToMessageId: "358",
				text: "(texto completo no arquivo)\n\nGravar?",
				buttons: [{ label: "Gravar", actionId: "kbq:52cf6:1" }],
				document: { data: "# Relatório\n\nGravar?", filename: "relatorio.md" },
			},
		});

		expect(result).toEqual({ messageId: "-1004378402573:402" });
		expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.telegram.org/bottoken/sendDocument");
		const form = init.body as FormData;
		expect(form.get("chat_id")).toBe("-1004378402573");
		expect(form.get("message_thread_id")).toBe("49");
		expect(form.get("caption")).toContain("Gravar?");
		expect(form.get("parse_mode")).toBe("MarkdownV2");
		expect(JSON.parse(String(form.get("reply_parameters")))).toEqual({
			message_id: 358,
			allow_sending_without_reply: true,
		});
		expect(JSON.parse(String(form.get("reply_markup")))).toEqual({
			inline_keyboard: [[{ text: "Gravar", callback_data: "kbq:52cf6:1" }]],
		});
		const file = form.get("document") as File;
		expect(file.name).toBe("relatorio.md");
		expect(await file.text()).toBe("# Relatório\n\nGravar?");
	});

	// Answering edits the question, and a message carrying a file has a caption, not a text.
	it("edits the caption of a message that carries a file", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({
					ok: false,
					description: "Bad Request: there is no text in the message to edit",
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true }),
			}) as unknown as typeof fetch;

		const edited = await editTelegramCardMessage({
			botToken: "token",
			messageRef: "-100:402",
			text: "Gravar?\n\n✅ Descartar",
			fetchImpl,
		});

		expect(edited).toBe(true);
		const [url, init] = vi.mocked(fetchImpl).mock.calls[1] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.telegram.org/bottoken/editMessageCaption");
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({ chat_id: "-100", message_id: 402 });
		expect(body.caption).toContain("Descartar");
		expect(body).not.toHaveProperty("text");
		expect(body).not.toHaveProperty("reply_markup");
	});
});

describe("a card question with its pictures", () => {
	const photo = {
		data: new Uint8Array([137, 80, 78, 71]),
		filename: "rascunho.png",
		mimeType: "image/png",
	};
	const okFetch = (messageId: number) =>
		vi.fn(async () => ({
			json: async () => ({ ok: true, result: { message_id: messageId } }),
		})) as unknown as typeof fetch;

	// An Instagram draft is approved by looking at it: one message, the picture with the
	// question as its caption and the choices under it.
	it("posts one picture with the question as its caption and the buttons under it", async () => {
		const fetchImpl = okFetch(410);

		const result = await postTelegramCardReply({
			botToken: "token",
			fetchImpl,
			request: {
				chatId: "-1004378402573",
				messageThreadId: "49",
				replyToMessageId: "358",
				text: "Aprovar o post?",
				buttons: [
					{ label: "Aprovar", actionId: "kbq:52cf6:1" },
					{ label: "Pedir ajuste", actionId: "kbq:52cf6:2" },
				],
				photo,
			},
		});

		expect(result).toEqual({ messageId: "-1004378402573:410" });
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.telegram.org/bottoken/sendPhoto");
		const form = init.body as FormData;
		expect(form.get("caption")).toContain("Aprovar o post?");
		expect(form.get("text")).toBeNull();
		expect(form.get("document")).toBeNull();
		expect(JSON.parse(String(form.get("reply_parameters")))).toEqual({
			message_id: 358,
			allow_sending_without_reply: true,
		});
		expect(JSON.parse(String(form.get("reply_markup")))).toEqual({
			inline_keyboard: [
				[{ text: "Aprovar", callback_data: "kbq:52cf6:1" }],
				[{ text: "Pedir ajuste", callback_data: "kbq:52cf6:2" }],
			],
		});
		const file = form.get("photo") as File;
		expect(file.name).toBe("rascunho.png");
		expect(file.type).toBe("image/png");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(photo.data);
	});

	// Answering edits the question; on a picture that is its caption, and the existing fallback
	// is what reaches it.
	it("marks the question answered by editing the picture's caption", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce({
				json: async () => ({
					ok: false,
					description: "Bad Request: there is no text in the message to edit",
				}),
			})
			.mockResolvedValueOnce({
				json: async () => ({ ok: true }),
			}) as unknown as typeof fetch;

		const edited = await editTelegramCardMessage({
			botToken: "token",
			messageRef: "-100:410",
			text: "Aprovar o post?\n\n✅ Aprovar",
			fetchImpl,
		});

		expect(edited).toBe(true);
		const calls = vi.mocked(fetchImpl).mock.calls as unknown as Array<
			[string, RequestInit]
		>;
		expect(calls[0]?.[0]).toBe(
			"https://api.telegram.org/bottoken/editMessageText",
		);
		expect(calls[1]?.[0]).toBe(
			"https://api.telegram.org/bottoken/editMessageCaption",
		);
		const body = JSON.parse(String(calls[1]?.[1].body));
		expect(body).toMatchObject({ chat_id: "-100", message_id: 410 });
		expect(body.caption).toContain("Aprovar");
		expect(body).not.toHaveProperty("reply_markup");
	});

	// An album takes no keyboard, so several pictures go first as one, replying to the card.
	it("posts several pictures as one album replying to the card", async () => {
		const fetchImpl = okFetch(411);
		const second = {
			...photo,
			filename: "slide-2.jpg",
			mimeType: "image/jpeg",
		};

		const posted = await postTelegramCardPhotos({
			botToken: "token",
			fetchImpl,
			chatId: "-100",
			messageThreadId: "49",
			replyToMessageId: "358",
			photos: [photo, second],
		});

		expect(posted).toBe(true);
		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.telegram.org/bottoken/sendMediaGroup");
		const form = init.body as FormData;
		expect(form.get("message_thread_id")).toBe("49");
		expect(form.get("reply_markup")).toBeNull();
		expect(JSON.parse(String(form.get("reply_parameters")))).toEqual({
			message_id: 358,
			allow_sending_without_reply: true,
		});
		expect(JSON.parse(String(form.get("media")))).toEqual([
			{ type: "photo", media: "attach://photo0" },
			{ type: "photo", media: "attach://photo1" },
		]);
		expect((form.get("photo0") as File).name).toBe("rascunho.png");
		expect((form.get("photo1") as File).name).toBe("slide-2.jpg");
	});

	// A lone picture before a question too long for a caption: no caption, no keyboard.
	it("posts a lone picture as a plain photo", async () => {
		const fetchImpl = okFetch(412);

		await postTelegramCardPhotos({
			botToken: "token",
			fetchImpl,
			chatId: "-100",
			replyToMessageId: "358",
			photos: [photo],
		});

		const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.telegram.org/bottoken/sendPhoto");
		const form = init.body as FormData;
		expect(form.get("caption")).toBeNull();
		expect(form.get("reply_markup")).toBeNull();
		expect((form.get("photo") as File).name).toBe("rascunho.png");
	});

	it("reports a refused album instead of throwing", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			postTelegramCardPhotos({
				botToken: "token",
				fetchImpl,
				chatId: "-100",
				replyToMessageId: "358",
				photos: [photo, photo],
			}),
		).resolves.toBe(false);
	});

	// The question matters more than any one picture: what cannot be sent is left out, and
	// nothing left means the question goes out as text.
	it("reads the pictures in order, skipping what cannot be sent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "card-photos-"));
		const first = join(dir, "b.png");
		const second = join(dir, "a.JPG");
		const empty = join(dir, "empty.png");
		const huge = join(dir, "huge.webp");
		const text = join(dir, "notes.txt");
		writeFileSync(first, Buffer.from([1, 2, 3]));
		writeFileSync(second, Buffer.from([4, 5]));
		writeFileSync(empty, "");
		writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1));
		writeFileSync(text, "x");

		const photos = await loadCardPhotos([
			first,
			join(dir, "missing.png"),
			empty,
			huge,
			text,
			dir,
			second,
		]);

		expect(photos.map((entry) => [entry.filename, entry.mimeType])).toEqual([
			["b.png", "image/png"],
			["a.JPG", "image/jpeg"],
		]);
		expect([...(photos[0]?.data ?? [])]).toEqual([1, 2, 3]);
		await expect(loadCardPhotos([join(dir, "missing.png")])).resolves.toEqual(
			[],
		);
	});
});
