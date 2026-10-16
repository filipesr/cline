import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SECRETS_FILE,
	loadSecrets,
	parseSecrets,
	secretsFilePath,
} from "./secrets";

describe("parseSecrets", () => {
	test("reads NAME=value, skips comments, empty lines and blank values", () => {
		const text = [
			"# R2",
			"R2_BUCKET=cline-marketing-instagram",
			"",
			'export R2_PUBLIC_BASE_URL="https://pub-x.r2.dev"',
			"COMPOSIO_CONSUMER_API_KEY='ck_a=b'",
			"R2_SECRET_ACCESS_KEY=",
			"no equals sign",
		].join("\n");
		expect(parseSecrets(text)).toEqual({
			R2_BUCKET: "cline-marketing-instagram",
			R2_PUBLIC_BASE_URL: "https://pub-x.r2.dev",
			COMPOSIO_CONSUMER_API_KEY: "ck_a=b",
		});
	});
});

describe("loadSecrets", () => {
	test("fills only what the environment is missing", () => {
		const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "instagram.env");
		writeFileSync(file, "R2_BUCKET=from-file\nR2_ACCESS_KEY_ID=from-file\n");
		const env: NodeJS.ProcessEnv = {
			INSTAGRAM_ENV_FILE: file,
			R2_BUCKET: "from-env",
		};
		loadSecrets(env);
		expect(env.R2_BUCKET).toBe("from-env");
		expect(env.R2_ACCESS_KEY_ID).toBe("from-file");
	});

	test("without a file, does nothing", () => {
		const env: NodeJS.ProcessEnv = {
			INSTAGRAM_ENV_FILE: join(tmpdir(), "missing-secrets.env"),
		};
		loadSecrets(env);
		expect(Object.keys(env)).toEqual(["INSTAGRAM_ENV_FILE"]);
	});

	test("the default file lives outside the repository", () => {
		expect(secretsFilePath({})).toBe(DEFAULT_SECRETS_FILE);
		expect(DEFAULT_SECRETS_FILE).toEndWith(
			join(".config", "cline-marketing", "instagram.env"),
		);
	});
});
