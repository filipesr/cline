import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Turns a demand written in a chat conversation into a Kanban card.
 *
 * This is the other direction of the hub/Kanban pair: a card entering review announces itself
 * into the conversation, and a demand raised in the conversation becomes a card. It goes through
 * the `kanban` CLI rather than the board file because the board is owned by a running Kanban
 * server -- the CLI's own `task create` talks to it over tRPC and writing the file behind its
 * back would lose the write or corrupt the revision counter.
 */

const TITLE_MAX_LENGTH = 60;

export interface KanbanTaskRequest {
	/** The demand as the person wrote it. Becomes the card's prompt verbatim. */
	description: string;
	/** Repository the card belongs to -- the conversation's workspace, not a worktree. */
	projectPath: string;
}

export interface KanbanTaskResult {
	ok: boolean;
	taskId?: string;
	message: string;
}

export interface KanbanCommandOutput {
	stdout: string;
}

export interface CreateKanbanTaskDependencies {
	/** Overridable for tests; defaults to running the real `kanban` binary. */
	run?: (args: string[]) => Promise<KanbanCommandOutput>;
}

/**
 * A card needs a short label for the board and the full text for the agent. The first line is
 * the label when it is short enough, because that is how people write a demand: a headline and
 * then the detail.
 */
export function deriveTaskTitle(description: string): string {
	const firstLine = description.split("\n", 1)[0] ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	if (collapsed.length <= TITLE_MAX_LENGTH) {
		return collapsed;
	}
	const clipped = collapsed.slice(0, TITLE_MAX_LENGTH);
	const lastSpace = clipped.lastIndexOf(" ");
	// Cutting mid-word reads like a defect, so prefer the last word boundary -- unless that
	// would throw away most of the line.
	const base =
		lastSpace > TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped;
	return `${base.trimEnd()}…`;
}

export function buildKanbanCreateArgs(request: KanbanTaskRequest): string[] {
	return [
		"task",
		"create",
		"--title",
		deriveTaskTitle(request.description),
		"--prompt",
		request.description,
		"--project-path",
		request.projectPath,
	];
}

/**
 * The CLI prints JSON on stdout, but Node writes deprecation warnings there in some versions,
 * so the object is located rather than assumed to start at byte zero.
 */
export function readCreatedTaskId(stdout: string): string | undefined {
	const start = stdout.indexOf("{");
	if (start < 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(stdout.slice(start)) as {
			ok?: boolean;
			task?: { id?: unknown };
		};
		if (parsed.ok === false) {
			return undefined;
		}
		const id = parsed.task?.id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function describeFailure(error: unknown): string {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	if (code === "ENOENT") {
		return "Kanban is not installed, so there is no board to add this to.";
	}
	const stderr =
		error && typeof error === "object" && "stderr" in error
			? String(error.stderr).trim()
			: "";
	const detail =
		stderr || (error instanceof Error ? error.message : String(error));
	const firstLine =
		detail
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	// A Kanban that is not running is the common case and deserves to say so plainly.
	if (/ECONNREFUSED|fetch failed/i.test(detail)) {
		return "Could not reach Kanban. Is the board running?";
	}
	return firstLine
		? `Kanban refused the task: ${firstLine}`
		: "Kanban refused the task.";
}

export async function createKanbanTask(
	request: KanbanTaskRequest,
	deps: CreateKanbanTaskDependencies = {},
): Promise<KanbanTaskResult> {
	const description = request.description.trim();
	if (!description) {
		return { ok: false, message: "Usage: /task <what needs doing>" };
	}
	const run =
		deps.run ??
		(async (args: string[]) => {
			const { stdout } = await execFileAsync("kanban", args, {
				maxBuffer: 1024 * 1024,
			});
			return { stdout: String(stdout) };
		});

	let stdout: string;
	try {
		({ stdout } = await run(
			buildKanbanCreateArgs({ ...request, description }),
		));
	} catch (error) {
		return { ok: false, message: describeFailure(error) };
	}

	const taskId = readCreatedTaskId(stdout);
	if (!taskId) {
		return { ok: false, message: "Kanban did not report a task id." };
	}
	return {
		ok: true,
		taskId,
		message: `Added to backlog as ${taskId}: ${deriveTaskTitle(description)}`,
	};
}
