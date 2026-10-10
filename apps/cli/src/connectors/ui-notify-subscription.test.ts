import { HubUIClient } from "@cline/core";
import type { HubUINotifyPayload } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";

import {
	startUiNotifyDelivery,
	type UiNotifyClient,
} from "./ui-notify-subscription";

type Handlers = { onNotify?: (payload: HubUINotifyPayload) => void };

function fakeClient() {
	let handlers: Handlers = {};
	let unsubscribed = 0;
	return {
		client: {
			connect: async () => undefined,
			subscribeUI: (h: Handlers) => {
				handlers = h;
				return () => {
					unsubscribed += 1;
				};
			},
			close: () => undefined,
			dispose: async () => undefined,
		},
		emit(payload: unknown) {
			handlers.onNotify?.(payload as HubUINotifyPayload);
		},
		get unsubscribed() {
			return unsubscribed;
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

describe("UiNotifyClient", () => {
	it("is satisfied by the real HubUIClient", () => {
		// The first version of this module declared a `subscribe` method that HubUIClient does
		// not have, and a cast hid it: every unit test passed against a fake with the invented
		// shape, and the running connector died with "client.subscribe is not a function".
		// This assignment is the check that was missing -- it fails to compile if the slice the
		// module depends on ever drifts from the class it is given at runtime.
		const real = null as unknown as HubUIClient;
		const asSlice: UiNotifyClient = real;
		expect(asSlice).toBe(real);
	});

	it("unsubscribes from the hub on stop", async () => {
		const fake = fakeClient();
		const subscription = await startUiNotifyDelivery({
			createClient: () => fake.client,
			readBindings: () => ({}),
			deliver: async () => undefined,
		});

		expect(fake.unsubscribed).toBe(0);
		await subscription.stop();
		expect(fake.unsubscribed).toBe(1);
	});
});
