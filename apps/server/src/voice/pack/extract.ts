// @effect-diagnostics nodeBuiltinImport:off - streaming gunzip and zip reads have no Effect equivalent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import * as Schema from "effect/Schema";
import yauzl from "yauzl";

export class UnsafeArchiveError extends Schema.TaggedError<UnsafeArchiveError>()(
  "UnsafeArchiveError",
  { message: Schema.String },
) {}

const BLOCK = 512;

/** A relative path inside `root`, or an error for absolute paths and `..` segments. */
function safeJoin(root: string, entry: string) {
  const parts = entry.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (/^([\\/]|[A-Za-z]:)/.test(entry) || parts.includes(".."))
    throw new UnsafeArchiveError({ message: `Archive entry "${entry}" leaves the voice pack.` });
  const target = NodePath.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + NodePath.sep))
    throw new UnsafeArchiveError({ message: `Archive entry "${entry}" leaves the voice pack.` });
  return target;
}

const readString = (block: Uint8Array, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
};
const readOctal = (block: Uint8Array, offset: number, length: number) =>
  Number.parseInt(readString(block, offset, length).trim() || "0", 8);

/** pax records: "<length> <key>=<value>\n". */
const parsePax = (data: Buffer) => {
  const records = new Map<string, string>();
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset);
    const length = Number(data.subarray(offset, space).toString());
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
};

/**
 * Extracts an npm tarball's package directory into `destination`. Only regular files and
 * directories are written; links, devices and paths outside `destination` are refused.
 * `include` sees each path relative to the package root.
 */
export async function extractNpmTarball(
  tarball: string,
  destination: string,
  include: (path: string) => boolean = () => true,
  signal?: AbortSignal,
) {
  const root = NodePath.resolve(destination);
  await NodeFSP.mkdir(root, { recursive: true });
  let pending: Buffer = Buffer.alloc(0);
  let longName: string | undefined;
  let pax = new Map<string, string>();
  // The current entry's body: where it goes (or undefined to skip) and bytes still to read.
  let body:
    | {
        remaining: number;
        padding: number;
        kind: "file" | "skip" | "x" | "g" | "L";
        collect?: Buffer[];
        file?: NodeFSP.FileHandle;
      }
    | undefined;
  let ended = false;

  const startEntry = async (header: Buffer) => {
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === "x" || type === "g" || type === "L") {
      body = { remaining: size, padding, collect: [], kind: type };
      return;
    }
    const prefix = readString(header, 345, 155);
    const rawName =
      pax.get("path") ?? longName ?? (prefix ? `${prefix}/` : "") + readString(header, 0, 100);
    pax = new Map();
    longName = undefined;
    // npm packs everything under one top-level directory, usually "package/".
    safeJoin(root, rawName);
    const relative = rawName
      .split(/[\\/]+/)
      .slice(1)
      .join("/");
    if (type !== "0" && type !== "\0" && type !== "5" && type !== "7")
      throw new UnsafeArchiveError({
        message: `Archive entry "${rawName}" is not a regular file.`,
      });
    const target = safeJoin(root, relative);
    // Directories appear as their files are written; npm never packs empty ones it needs.
    if (type === "5" || relative === "" || !include(relative)) {
      body = { remaining: size, padding, kind: "skip" };
      return;
    }
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    const executable = (readOctal(header, 100, 8) & 0o111) !== 0;
    const file = await NodeFSP.open(target, "w", executable ? 0o755 : 0o644);
    body = { remaining: size, padding, file, kind: "file" };
  };

  const finishEntry = async () => {
    const done = body!;
    body = undefined;
    await done.file?.close();
    if (!done.collect) return;
    const data = Buffer.concat(done.collect);
    if (done.kind === "L") longName = readString(data, 0, data.length);
    else if (done.kind === "x") pax = parsePax(data);
  };

  const consume = async (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (!ended) {
      if (body) {
        if (body.remaining > 0) {
          if (pending.length === 0) return;
          const piece = pending.subarray(0, Math.min(body.remaining, pending.length));
          pending = pending.subarray(piece.length);
          body.remaining -= piece.length;
          if (body.file) await body.file.write(piece);
          else if (body.collect) body.collect.push(Buffer.from(piece));
          continue;
        }
        if (pending.length < body.padding) return;
        pending = pending.subarray(body.padding);
        await finishEntry();
        continue;
      }
      if (pending.length < BLOCK) return;
      const header = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        return;
      }
      await startEntry(Buffer.from(header));
    }
  };

  try {
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(tarball),
      NodeZlib.createGunzip(),
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) await consume(chunk);
      },
      signal ? { signal } : {},
    );
    if (body) throw new UnsafeArchiveError({ message: "The archive ended inside an entry." });
  } finally {
    await body?.file?.close();
  }
}

/** Copies the named members of a wheel (a zip) flat into `destination`. */
export async function extractWheelFiles(
  wheel: string,
  destination: string,
  members: readonly string[],
  signal?: AbortSignal,
) {
  const root = NodePath.resolve(destination);
  await NodeFSP.mkdir(root, { recursive: true });
  const wanted = new Set(members);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(wheel, { lazyEntries: true, autoClose: false }, (error, file) =>
      error ? reject(error) : resolve(file),
    ),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName)) return zip.readEntry();
        wanted.delete(entry.fileName);
        const target = safeJoin(root, NodePath.posix.basename(entry.fileName));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          NodeStreamPromises.pipeline(
            stream,
            NodeFS.createWriteStream(target, { mode: 0o755 }),
            signal ? { signal } : {},
          ).then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (wanted.size > 0)
    throw new UnsafeArchiveError({ message: `The wheel lacks ${[...wanted].join(", ")}.` });
}
