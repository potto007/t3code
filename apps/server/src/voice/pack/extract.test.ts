// @effect-diagnostics nodeBuiltinImport:off - fixture packs are plain files the worker reads from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { expect, it } from "vite-plus/test";

import { extractNpmTarball } from "./extract.ts";

type Entry = {
  readonly name: string;
  readonly body?: string;
  readonly type?: string;
  readonly mode?: number;
  readonly linkname?: string;
};

const header = (entry: Entry, size: number) => {
  const block = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) =>
    block.write(text, offset, length, "utf8");
  const octal = (value: number, offset: number, length: number) =>
    put(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  put(entry.name.slice(0, 100), 0, 100);
  octal(entry.mode ?? 0o644, 100, 8);
  octal(size, 124, 12);
  put(entry.type ?? "0", 156, 1);
  put(entry.linkname ?? "", 157, 100);
  put("ustar\x0000", 257, 8);
  block.fill(0x20, 148, 156);
  octal(
    block.reduce((sum, byte) => sum + byte, 0),
    148,
    7,
  );
  return block;
};

/** A gzipped tar; names over 100 bytes get a pax `path` record, as npm writes them. */
const tarball = (entries: readonly Entry[]) => {
  const blocks: Buffer[] = [];
  const add = (entry: Entry, body: Buffer) => {
    blocks.push(header(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  for (const entry of entries) {
    if (entry.name.length > 100) {
      const record = ` path=${entry.name}\n`;
      let length = record.length;
      length += String(length + String(length).length).length;
      add({ name: "PaxHeader", type: "x" }, Buffer.from(`${length}${record}`));
    }
    add(entry, Buffer.from(entry.body ?? ""));
  }
  blocks.push(Buffer.alloc(1024));
  return NodeZlib.gzipSync(Buffer.concat(blocks));
};

const withTarball = async (
  entries: readonly Entry[],
  run: (file: string, destination: string, root: string) => Promise<void>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pack-extract-"));
  try {
    const file = NodePath.join(root, "package.tgz");
    NodeFS.writeFileSync(file, tarball(entries));
    await run(file, NodePath.join(root, "pack", "node_modules", "fixture"), root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
};

it("extracts the package directory with modes and long paths, skipping excluded files", async () => {
  const deep = `package/${"nested/".repeat(16)}deep.js`;
  await withTarball(
    [
      { name: "package/", type: "5" },
      { name: "package/package.json", body: `{"name":"fixture"}` },
      { name: "package/bin/addon.node", body: "binary", mode: 0o755 },
      { name: "package/bin/other/addon.node", body: "other platform" },
      { name: deep, body: "deep" },
    ],
    async (file, destination) => {
      await extractNpmTarball(file, destination, (path) => !path.startsWith("bin/other/"));
      const read = (path: string) => NodeFS.readFileSync(NodePath.join(destination, path), "utf8");
      expect(read("package.json")).toBe(`{"name":"fixture"}`);
      expect(read(deep.slice("package/".length))).toBe("deep");
      expect(NodeFS.statSync(NodePath.join(destination, "bin/addon.node")).mode & 0o111).not.toBe(
        0,
      );
      expect(NodeFS.existsSync(NodePath.join(destination, "bin/other"))).toBe(false);
    },
  );
});

it.each([
  ["a parent segment", { name: "package/../../escape.js", body: "x" }],
  ["an absolute path", { name: "/tmp/escape.js", body: "x" }],
  ["a symlink", { name: "package/link", type: "2", linkname: "/etc/passwd" }],
  ["a hard link", { name: "package/link", type: "1", linkname: "package/package.json" }],
] as const)("refuses %s and writes nothing outside the package", async (_, entry) => {
  await withTarball([entry], async (file, destination, root) => {
    await expect(extractNpmTarball(file, destination)).rejects.toThrow(
      /leaves the voice pack|not a regular file/,
    );
    expect(NodeFS.readdirSync(root).sort()).toEqual(["pack", "package.tgz"]);
    expect(NodeFS.existsSync(NodePath.join(root, "pack", "escape.js"))).toBe(false);
  });
});
