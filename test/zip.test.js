import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { zip, crc32 } from "../src/zip.js";

// A tiny reader for the tests: walk the local headers and return the entries.
// Enough to prove the writer's offsets, sizes and checksums are consistent.
export function entries(buf) {
  const out = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const csize = buf.readUInt32LE(off + 18);
    const usize = buf.readUInt32LE(off + 22);
    const nlen = buf.readUInt16LE(off + 26);
    const xlen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nlen);
    const start = off + 30 + nlen + xlen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(data.length, usize, `${name}: uncompressed size`);
    assert.equal(crc32(data), crc, `${name}: crc`);
    out.push({ name, method, data: data.toString("utf8") });
    off = start + csize;
  }
  assert.equal(buf.readUInt32LE(off), 0x02014b50, "central directory follows the entries");
  const cdOffset = off;
  for (let i = 0; i < out.length; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const nlen = buf.readUInt16LE(off + 28);
    assert.equal(buf.toString("utf8", off + 46, off + 46 + nlen), out[i].name);
    off += 46 + nlen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  assert.equal(buf.readUInt32LE(off), 0x06054b50, "end record");
  assert.equal(buf.readUInt16LE(off + 10), out.length, "entry count");
  assert.equal(buf.readUInt32LE(off + 16), cdOffset, "central directory offset");
  assert.equal(off + 22, buf.length, "nothing after the end record");
  return out;
}

test("crc32 matches the reference value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("zip round-trips names, folders and content", () => {
  const big = "# Big\n\n" + "the same line again and again\n".repeat(200);
  const buf = zip([
    { name: "a.md", data: "# A\n", mtime: new Date("2026-09-02T10:15:00Z") },
    { name: "team/design.md", data: big },
    { name: "ünïcode/nöte.md", data: "```mermaid\ngraph TD; A-->B\n```\n" },
  ]);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const got = entries(buf);
  assert.deepEqual(got.map((e) => e.name), ["a.md", "team/design.md", "ünïcode/nöte.md"]);
  assert.equal(got[0].data, "# A\n");
  assert.equal(got[0].method, 0, "tiny file is stored, not inflated by deflate");
  assert.equal(got[1].method, 8, "repetitive file is deflated");
  assert.equal(got[1].data, big);
  assert.match(got[2].data, /graph TD; A-->B/);
});

test("an empty archive is still a valid zip", () => {
  const buf = zip([]);
  assert.equal(buf.length, 22);
  assert.equal(buf.readUInt32LE(0), 0x06054b50);
});
