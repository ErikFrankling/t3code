#!/usr/bin/env node
// Fork-only: builds the update index that Erik's phone follows
// (docs/erik-updates.md). One rolling GitHub release, `android-ota`, holds
// `index.json` plus content-addressed JS bundles and assets:
//
//   { "apk": { versionCode, versionName, url, sha256, size, runtimeVersion, commit },
//     "runtimes": { "<runtimeVersion>": { id, createdAt, commit, manifest, signature } } }
//
// `manifest` is the exact expo-updates manifest string the update server sends
// and `signature` its expo-signature header, signed here with the fork's key.
//
//   node scripts/erik-updates.mjs ota --dist <expo export dir> --config <expo config json>
//     --runtime <runtimeVersion> --key <private-key.pem> --base-url <asset url prefix>
//     --index <index.json> --blobs <out dir> [--commit <sha>]
//   node scripts/erik-updates.mjs apk --apk <file> --version-code <n> --version-name <s>
//     --url <download url> --runtime <runtimeVersion> --index <index.json> [--commit <sha>]
//   node scripts/erik-updates.mjs keep --index <index.json>   (blob names still referenced)
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

const KEEP_RUNTIMES = 4;

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function required(args, name) {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readIndex(path) {
  if (!FS.existsSync(path)) return { apk: null, runtimes: {} };
  const index = JSON.parse(FS.readFileSync(path, "utf8"));
  return { apk: index.apk ?? null, runtimes: index.runtimes ?? {} };
}

function writeIndex(path, index) {
  const runtimes = Object.entries(index.runtimes)
    .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, KEEP_RUNTIMES);
  FS.writeFileSync(
    path,
    `${JSON.stringify({ ...index, runtimes: Object.fromEntries(runtimes) }, null, 2)}\n`,
  );
}

const digest = (algorithm, data, encoding) =>
  Crypto.createHash(algorithm).update(data).digest(encoding);

/** expo-updates wants a UUID id; derive it from the export so it is stable. */
function uuidFromHex(hex) {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function ota(args) {
  const dist = required(args, "dist");
  const runtimeVersion = required(args, "runtime");
  const baseUrl = required(args, "base-url").replace(/\/$/, "");
  const blobs = required(args, "blobs");
  const indexPath = required(args, "index");
  const expoConfig = JSON.parse(FS.readFileSync(required(args, "config"), "utf8"));
  const privateKey = FS.readFileSync(required(args, "key"), "utf8");
  FS.mkdirSync(blobs, { recursive: true });

  const metadataRaw = FS.readFileSync(Path.join(dist, "metadata.json"));
  const metadata = JSON.parse(metadataRaw);
  const android = metadata.fileMetadata?.android;
  if (!android?.bundle) throw new Error("metadata.json has no Android bundle");

  const asset = (relativePath, ext, contentType) => {
    const data = FS.readFileSync(Path.join(dist, relativePath));
    const key = digest("md5", data, "hex");
    const name = `${key}.${ext}`;
    FS.writeFileSync(Path.join(blobs, name), data);
    return {
      hash: digest("sha256", data, "base64url"),
      key,
      contentType,
      fileExtension: `.${ext}`,
      url: `${baseUrl}/${name}`,
    };
  };

  const createdAt = new Date().toISOString();
  const id = uuidFromHex(
    digest("sha256", Buffer.concat([metadataRaw, Buffer.from(createdAt)]), "hex"),
  );
  const manifest = JSON.stringify({
    id,
    createdAt,
    runtimeVersion,
    launchAsset: asset(android.bundle, "bundle", "application/javascript"),
    assets: android.assets.map((entry) =>
      asset(entry.path, entry.ext, MIME[entry.ext] ?? "application/octet-stream"),
    ),
    metadata: {},
    extra: { expoClient: expoConfig },
  });
  const sig = Crypto.createSign("RSA-SHA256").update(manifest, "utf8").sign(privateKey, "base64");

  const index = readIndex(indexPath);
  index.runtimes[runtimeVersion] = {
    id,
    createdAt,
    commit: args.commit ?? null,
    manifest,
    signature: `sig="${sig}", keyid="main"`,
  };
  writeIndex(indexPath, index);
  console.log(`update ${id} for runtime ${runtimeVersion}, ${android.assets.length + 1} files`);
}

function apk(args) {
  const indexPath = required(args, "index");
  const data = FS.readFileSync(required(args, "apk"));
  const index = readIndex(indexPath);
  index.apk = {
    versionCode: Number(required(args, "version-code")),
    versionName: required(args, "version-name"),
    url: required(args, "url"),
    sha256: digest("sha256", data, "hex"),
    size: data.length,
    runtimeVersion: required(args, "runtime"),
    commit: args.commit ?? null,
  };
  // The APK embeds the newest JS for its runtime; older OTAs for it are stale.
  delete index.runtimes[index.apk.runtimeVersion];
  writeIndex(indexPath, index);
  console.log(`apk ${index.apk.versionName} (${index.apk.versionCode})`);
}

function keep(args) {
  const index = readIndex(required(args, "index"));
  const names = new Set();
  for (const entry of Object.values(index.runtimes)) {
    const manifest = JSON.parse(entry.manifest);
    for (const file of [manifest.launchAsset, ...manifest.assets]) {
      names.add(file.url.slice(file.url.lastIndexOf("/") + 1));
    }
  }
  for (const name of [...names].sort()) console.log(name);
}

const [command, ...rest] = process.argv.slice(2);
const commands = { ota, apk, keep };
if (!commands[command]) {
  console.error("usage: erik-updates.mjs ota|apk|keep --flag value ...");
  process.exit(2);
}
commands[command](parseArgs(rest));
