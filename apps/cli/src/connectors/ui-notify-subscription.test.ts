import { describe, expect, it, vi } from "vitest";

import { startUiNotifyDelivery } from "./ui-notify-subscription";

type Handlers = { onNotify?: (payload: unknown) => void };

function fakeClient() {
	let handlers: Handlers = {};
	return {
		client: {
			connect: async () => undefined,
			subscribe: (h: Handlers) => {
				handlers = h;
			},
			close: () => undefined,
			dispose: async () => undefined,
		},
		emit(payload: unknown) {
			handlers.onNotify?.(payload);
		},
	};
}

describe("startUiNotifyDelivery", () => {
	it("delivers to the thread bound to the notification's workspace", async () => {
		const fake = fakeClient();
		const deliver = vi.fn<(threadKey: string, text: string) => Promise<void>>(
			async () => undefined,
		);
		const subscription = await startUiNotifyDelivery({
			createClient: () => fake.client,
			readBindings: () => ({ t1: { state: { cwd: "/code/app" } } }),
			deliver,
		});

		fake.emit({
			title: "Ready for review",
			body: "Card — app",
			source: { workspacePath: "/code/app" },
		});
		await subscription.flush();

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0][0]).toBe("t1");
		expect(deliver.mock.calls[0][1]).toContain("Ready for review");
	});

	// The guarantee that makes this safe to turn on: an event we cannot place goes nowhere.
	it("delivers nothing when no thread is bound to that workspace", async () => {
		const fake = fakeClient();
		const deliver = vi.fn<(threadKey: string, text: string) => Promise<void>>(
			async () => undefined,
		);
		const subscription = await startUiNotifyDelivery({
			createClient: () => fake.client,
			readBindings: () => ({ t1: { state: { cwd: "/code/app" } } }),
			deliver,
		});

		fake.emit({
			title: "x",
			body: "y",
			source: { workspacePath: "/code/elsewhere" },
		});
		await subscription.flush();
		expect(deliver).not.toHaveBeenCalled();
	});

	// A connector that dies because a notification could not be posted is worse than one that
	// misses the notification: the first takes the conversation down with it.
	it("survives a delivery that throws", async () => {
		const fake = fakeClient();
		const subscription = await startUiNotifyDelivery({
			createClient: () => fake.client,
			readBindings: () => ({ t1: { state: { cwd: "/code/app" } } }),
			deliver: async () => {
				throw new Error("telegram is down");
			},
		});

		fake.emit({
			title: "x",
			body: "y",
			source: { workspacePath: "/code/app" },
		});
		await expect(subscription.flush()).resolves.toBeUndefined();
	});

	it("survives a malformed event instead of crashing the connector", async () => {
		const fake = fakeClient();
		const deliver = vi.fn<(threadKey: string, text: string) => Promise<void>>(
			async () => undefined,
		);
		const subscription = await startUiNotifyDelivery({
			createClient: () => fake.client,
			readBindings: () => ({ t1: { state: { cwd: "/code/app" } } }),
			deliver,
		});

		fake.emit(null);
		fake.emit("not an object");
		fake.emit({ source: { workspacePath: "/code/app" } });
		await subscription.flush();
		expect(deliver).not.toHaveBeenCalled();
	});
});
