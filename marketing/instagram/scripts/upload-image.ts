#!/usr/bin/env bun
/**
 * Uploads a PNG/JPEG to a Cloudflare R2 bucket and prints its public HTTPS
 * URL, which is what the Instagram publish API (and Composio's action) expects
 * as image_url.
 *
 * Usage: bun scripts/upload-image.ts <path/to/image.(png|jpg|jpeg)> [--check]
 * Env:   R2_ENDPOINT (or S3_API), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *        R2_BUCKET, R2_PUBLIC_BASE_URL (see marketing/instagram/README.md), read from
 *        ~/.config/cline-marketing/instagram.env when not already set (see segredos.ts)
 *
 * --check fetches the URL without credentials and fails unless it answers 200
 * with an image content-type.
 */
import { randomUUID } from "node:crypto"
import { basename, extname } from "node:path"
import { S3Client } from "bun"
import { carregarSegredos } from "./segredos"

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
}
// Instagram rejects images over 8 MB.
const MAX_BYTES = 8 * 1024 * 1024
function fail(message: string): never {
	console.error(`error: ${message}`)
	process.exit(1)
}

const args = process.argv.slice(2)
const check = args.includes("--check")
const filePath = args.find((arg) => !arg.startsWith("--"))
if (!filePath) fail("usage: bun scripts/upload-image.ts <image.png|image.jpg> [--check]")

// The dashboard's "S3 API" field is the endpoint with the bucket as its path,
// so S3_API stands in for R2_ENDPOINT and, without R2_BUCKET, for the bucket too.
carregarSegredos()
const read = (name: string) => process.env[name]?.trim() || undefined
const endpointUrl = read("R2_ENDPOINT") ?? read("S3_API")
let endpoint: URL | undefined
if (endpointUrl) {
	try {
		endpoint = new URL(endpointUrl)
	} catch {
		fail(`R2_ENDPOINT/S3_API is not a URL: "${endpointUrl}"`)
	}
}
const env = {
	endpoint: endpoint?.origin,
	accessKeyId: read("R2_ACCESS_KEY_ID"),
	secretAccessKey: read("R2_SECRET_ACCESS_KEY"),
	bucket: read("R2_BUCKET") ?? endpoint?.pathname.split("/").filter(Boolean)[0],
	publicBaseUrl: read("R2_PUBLIC_BASE_URL"),
}

const WHERE: Record<keyof typeof env, string> = {
	endpoint: "R2_ENDPOINT or S3_API: bucket → Settings → S3 API",
	accessKeyId: "R2_ACCESS_KEY_ID: R2 → Manage API tokens, shown when the token is created",
	secretAccessKey: "R2_SECRET_ACCESS_KEY: shown with the Access Key ID when the token is created",
	bucket: "R2_BUCKET: the bucket name, cline-marketing-instagram",
	publicBaseUrl: "R2_PUBLIC_BASE_URL: bucket → Settings → Public Development URL",
}
const missing = (Object.keys(env) as (keyof typeof env)[]).filter((field) => !env[field])
if (missing.length > 0) {
	fail(
		`missing (see marketing/instagram/README.md):\n${missing.map((field) => `  - ${WHERE[field]}`).join("\n")}`,
	)
}
const config = env as Record<keyof typeof env, string>

const ext = extname(filePath).toLowerCase()
const contentType = CONTENT_TYPES[ext]
if (!contentType) fail(`unsupported extension "${ext}", expected .png, .jpg or .jpeg`)

const file = Bun.file(filePath)
if (!(await file.exists())) fail(`file not found: ${filePath}`)
if (file.size > MAX_BYTES) fail(`file is ${file.size} bytes, Instagram accepts at most ${MAX_BYTES}`)

// A random prefix keeps re-uploads of the same file name from overwriting a
// URL that a scheduled post may still point at.
const stem = basename(filePath, extname(filePath)).replace(/[^a-zA-Z0-9._-]+/g, "-")
const key = `instagram/${randomUUID().slice(0, 8)}-${stem}${ext === ".jpeg" ? ".jpg" : ext}`

const r2 = new S3Client({
	endpoint: config.endpoint,
	accessKeyId: config.accessKeyId,
	secretAccessKey: config.secretAccessKey,
	bucket: config.bucket,
	region: "auto",
})
await r2.write(key, file, { type: contentType })

const url = `${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`

if (check) {
	const response = await fetch(url)
	const served = response.headers.get("content-type") ?? ""
	if (!response.ok || !served.startsWith("image/")) {
		fail(`${url} answered ${response.status} with content-type "${served}"`)
	}
	console.error(`ok: ${response.status} ${served}`)
}

console.log(url)
