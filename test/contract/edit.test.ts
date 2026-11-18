import assert from "node:assert/strict";
import { test } from "bun:test";
import { applyEdit } from "../../src/edit.js";

const edit = (old_string: string, new_string: string, replace_all = false) => ({
  old_string,
  new_string,
  replace_all,
});

test("applyEdit replaces a unique match", () => {
  assert.equal(applyEdit("a b c", edit("b", "x")), "a x c");
});

test("applyEdit rejects identical strings", () => {
  assert.throws(() => applyEdit("a", edit("a", "a")), {
    message:
      "No changes to make: old_string and new_string are exactly the same.",
  });
});

test("applyEdit reports a missing string", () => {
  assert.throws(() => applyEdit("abc", edit("zzz", "x")), {
    message: "String to replace not found in file.\nString: zzz",
  });
});

test("applyEdit refuses multiple matches unless replace_all", () => {
  assert.throws(() => applyEdit("aXaXa", edit("a", "b")), {
    message:
      "Found 3 matches of the string to replace, but replace_all is false. Set replace_all to true to replace every occurrence, or add surrounding context to make the match unique.\nString: a",
  });
  assert.equal(applyEdit("aXaXa", edit("a", "b", true)), "bXbXb");
});

test("applyEdit counts non-overlapping matches", () => {
  assert.equal(applyEdit("aaa", edit("aa", "b")), "ba");
  assert.equal(applyEdit("aaaa", edit("aa", "b", true)), "bb");
});

test("applyEdit treats new_string literally", () => {
  assert.equal(applyEdit("foo", edit("foo", "[$&][$1][$$]")), "[$&][$1][$$]");
  assert.equal(applyEdit("foo foo", edit("foo", "$&$&", true)), "$&$& $&$&");
});

test("applyEdit deletion also removes a trailing newline", () => {
  assert.equal(applyEdit("a\nb\nc\n", edit("b", "")), "a\nc\n");
  assert.equal(applyEdit("a\nb\nb\n", edit("b", "", true)), "a\n");
  assert.equal(applyEdit("a b", edit("b", "")), "a ");
  assert.equal(applyEdit("a\nb\n", edit("b\n", "")), "a\n");
});

test("applyEdit keeps CRLF files CRLF when old_string uses LF", () => {
  assert.equal(
    applyEdit("a\r\nb\r\nc\r\n", edit("a\nb", "x\ny")),
    "x\r\ny\r\nc\r\n",
  );
  assert.equal(applyEdit("a\r\nb\r\n", edit("b", "")), "a\r\n");
});

test("applyEdit normalizes mixed CRLF input before matching in LF-majority files", () => {
  assert.equal(applyEdit("a\nb\r\nc\n", edit("b\n", "B\n")), "a\nB\nc\n");
  assert.throws(
    () => applyEdit("a\nb\r\nc\n", edit("b\r\n", "B\r\n")),
    /not found/,
  );
});

test("applyEdit preserves a leading BOM", () => {
  assert.equal(applyEdit("﻿hello", edit("hello", "bye")), "﻿bye");
  assert.equal(applyEdit("﻿a\r\nb\r\n", edit("a", "x")), "﻿x\r\nb\r\n");
});

test("applyEdit checks uniqueness on old_string before widening a deletion to its newline", () => {
  assert.throws(
    () =>
      applyEdit("x\nx y", {
        old_string: "x",
        new_string: "",
        replace_all: false,
      }),
    /^Error: Found 2 matches/,
  );
  assert.equal(
    applyEdit("x\nx y", { old_string: "x", new_string: "", replace_all: true }),
    "x y",
  );
});
