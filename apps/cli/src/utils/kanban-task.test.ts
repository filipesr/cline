import { describe, expect, it, vi } from "vitest";

import {
	buildKanbanCreateArgs,
	createKanbanTask,
	deriveTaskTitle,
	readCreatedTaskId,
} from "./kanban-task";

const OK = '{"ok":true,"task":{"id":"65f2d","title":"x"}}';

describe("deriveTaskTitle", () => {
	it("uses the first line as written when it is short", () => {
		expect(
			deriveTaskTitle("Congelar a margem no aceite\n\ndetalhe longo"),
		).toBe("Congelar a margem no aceite");
	});

	it("collapses the whitespace people leave when typing on a phone", () => {
		expect(deriveTaskTitle("  medir   a    suite ")).toBe("medir a suite");
	});

	it("cuts a long line at a word boundary", () => {
		const title = deriveTaskTitle(
			"renomear own_portfolio porque o nome mente sobre o que a coluna guarda hoje",
		);
		expect(title.endsWith("…")).toBe(true);
		expect(title.length).toBeLessThanOrEqual(61);
		expect(title).not.toMatch(/\s…$/);
		// A word boundary, not a mid-word slice.
		expect(
			"renomear own_portfolio porque o nome mente sobre o que a coluna guarda hoje",
		).toContain(title.slice(0, -1));
	});

	it("still clips a single unbroken run that has no boundary to use", () => {
		const title = deriveTaskTitle("a".repeat(200));
		expect(title).toBe(`${"a".repeat(60)}…`);
	});
});

describe("buildKanbanCreateArgs", () => {
	it("sends the full text as the prompt and the derived line as the title", () => {
		const args = buildKanbanCreateArgs({
			description: "Titulo curto\ncorpo com detalhe",
			projectPath: "/code/partyshare",
		});
		expect(args).toEqual([
			"task",
			"create",
			"--title",
			"Titulo curto",
			"--prompt",
			"Titulo curto\ncorpo com detalhe",
			"--project-path",
			"/code/partyshare",
		]);
	});
});

describe("readCreatedTaskId", () => {
	it("finds the object even behind a node warning on stdout", () => {
		expect(
			readCreatedTaskId(`(node:1) DeprecationWarning: whatever\n${OK}`),
		).toBe("65f2d");
	});

	it("returns nothing for output that is not the expected shape", () => {
		expect(readCreatedTaskId("")).toBeUndefined();
		expect(readCreatedTaskId("not json at all")).toBeUndefined();
		expect(readCreatedTaskId('{"ok":false,"task":{"id":"x"}}')).toBeUndefined();
		expect(readCreatedTaskId('{"ok":true,"task":{}}')).toBeUndefined();
	});
});

describe("createKanbanTask", () => {
	it("creates the card in the conversation's repository", async () => {
		const run = vi.fn<(args: string[]) => Promise<{ stdout: string }>>(
			async () => ({
				stdout: OK,
			}),
		);
		const result = await createKanbanTask(
			{ description: "Congelar a margem", projectPath: "/code/partyshare" },
			{ run },
		);
		expect(result.ok).toBe(true);
		expect(result.taskId).toBe("65f2d");
		expect(run.mock.calls[0]?.[0]).toContain("/code/partyshare");
	});

	it("asks for a description instead of creating an empty card", async () => {
		const run = vi.fn(async () => ({ stdout: OK }));
		const result = await createKanbanTask(
			{ description: "   ", projectPath: "/code/app" },
			{ run },
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Usage:");
		expect(run).not.toHaveBeenCalled();
	});

	it("says plainly that the board is not running", async () => {
		const result = await createKanbanTask(
			{ description: "x", projectPath: "/code/app" },
			{
				run: async () => {
					throw Object.assign(new Error("fetch failed"), {
						stderr: "fetch failed",
					});
				},
			},
		);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(
			"Could not reach Kanban. Is the board running?",
		);
	});

	it("says plainly that Kanban is not installed", async () => {
		const result = await createKanbanTask(
			{ description: "x", projectPath: "/code/app" },
			{
				run: async () => {
					throw Object.assign(new Error("spawn kanban ENOENT"), {
						code: "ENOENT",
					});
				},
			},
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not installed");
	});

	it("does not claim success when Kanban answers without an id", async () => {
		const result = await createKanbanTask(
			{ description: "x", projectPath: "/code/app" },
			{ run: async () => ({ stdout: '{"ok":true}' }) },
		);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("did not report a task id");
	});
});
