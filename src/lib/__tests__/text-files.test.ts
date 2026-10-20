import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT_EDIT_MAX_BYTES,
  caretPosition,
  decodeTextFile,
  encodeTextFile,
  ensureTextFileName,
  isEditableTextFile,
  textByteSize,
  textMimeType,
} from "../text-files.ts";

describe("ensureTextFileName", () => {
  it("adds .txt only when there is no extension", () => {
    assert.equal(ensureTextFileName("Ghi chú"), "Ghi chú.txt");
    assert.equal(ensureTextFileName("notes.md"), "notes.md");
    assert.equal(ensureTextFileName("  todo  "), "todo.txt");
  });

  it("falls back to a default name and strips unsafe characters", () => {
    assert.equal(ensureTextFileName("   "), "Untitled.txt");
    assert.equal(ensureTextFileName("a/b\\c:d"), "a_b_c_d.txt");
    assert.equal(ensureTextFileName("..hidden"), "hidden.txt");
    assert.equal(ensureTextFileName("report."), "report..txt");
  });
});

describe("isEditableTextFile", () => {
  it("accepts small text files", () => {
    assert.equal(isEditableTextFile({ name: "a.txt", mime_type: "text/plain", size: 10 }), true);
    assert.equal(isEditableTextFile({ name: "a.md", mime_type: "application/octet-stream", size: 10 }), true);
  });

  it("rejects binary and oversized files", () => {
    assert.equal(isEditableTextFile({ name: "a.pdf", mime_type: "application/pdf", size: 10 }), false);
    assert.equal(
      isEditableTextFile({ name: "a.txt", mime_type: "text/plain", size: TEXT_EDIT_MAX_BYTES + 1 }),
      false
    );
  });
});

describe("textMimeType", () => {
  it("keeps an existing text type and infers one from the extension", () => {
    assert.equal(textMimeType("a.txt", "text/x-log"), "text/x-log");
    assert.equal(textMimeType("a.md", "application/octet-stream"), "text/markdown");
    assert.equal(textMimeType("a.txt"), "text/plain");
  });
});

describe("textByteSize / caretPosition", () => {
  it("counts UTF-8 bytes", () => {
    assert.equal(textByteSize("abc"), 3);
    assert.equal(textByteSize("ệ"), 3);
  });

  it("reports 1-based line and column", () => {
    assert.deepEqual(caretPosition("ab\ncd", 0), { line: 1, column: 1 });
    assert.deepEqual(caretPosition("ab\ncd", 4), { line: 2, column: 2 });
    assert.deepEqual(caretPosition("ab", 99), { line: 1, column: 3 });
  });
});

describe("decodeTextFile / encodeTextFile", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);

  it("decodes UTF-8 and keeps track of a byte-order mark", () => {
    assert.deepEqual(decodeTextFile(utf8("Tiến độ\nngày 1")), { text: "Tiến độ\nngày 1", bom: false });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("a,b")]);
    assert.deepEqual(decodeTextFile(withBom), { text: "a,b", bom: true });
    assert.equal(encodeTextFile("a,b", true), "\uFEFFa,b");
    assert.equal(encodeTextFile("a,b", false), "a,b");
  });

  it("refuses bytes that are not UTF-8 text", () => {
    assert.equal(decodeTextFile(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), null); // UTF-16LE
    assert.equal(decodeTextFile(new Uint8Array([0x54, 0xe9, 0x74])), null); // Latin-1 "Tét"
    assert.equal(decodeTextFile(new Uint8Array([0x61, 0x00, 0x62])), null); // binary
  });
});
