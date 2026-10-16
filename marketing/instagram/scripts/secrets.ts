/**
 * Loads the keys from a file outside the repository, so they survive the end of each card:
 * a Kanban worktree is deleted when its card finishes, and its .env goes with it.
 *
 * File: $INSTAGRAM_ENV_FILE, or ~/.config/cline-marketing/instagram.env. Lines NAME=value;
 * empty lines and lines starting with # are ignored, quotes around the value are stripped.
 * A variable already in the environment (or in a .env loaded by Bun) is not overwritten.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SECRETS_FILE = join(
	homedir(),
	".config",
	"cline-marketing",
	"instagram.env",
);

export function secretsFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return env.INSTAGRAM_ENV_FILE?.trim() || DEFAULT_SECRETS_FILE;
}

export function parseSecrets(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const equals = trimmed.indexOf("=");
		if (equals <= 0) continue;
		const name = trimmed
			.slice(0, equals)
			.replace(/^export\s+/, "")
			.trim();
		let value = trimmed.slice(equals + 1).trim();
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		if (value) values[name] = value;
	}
	return values;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): void {
	const file = secretsFilePath(env);
	if (!existsSync(file)) return;
	for (const [name, value] of Object.entries(
		parseSecrets(readFileSync(file, "utf8")),
	)) {
		if (!env[name]?.trim()) env[name] = value;
	}
}
