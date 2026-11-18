import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyEdit } from "../src/edit.js";
import { createTools } from "../src/tools.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), "tau-file-fidelity-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = createTools({ cwd, mode: "acceptEdits", approve: async () => false });
  const run = (name: string, input: Record<string, unknown>) => tools.execute({ type: "tool_use", id: "fidelity", name, input }, new AbortController().signal);
  return { cwd, run, file: path.join(cwd, "a") };
}
const edit = (old_string: string, new_string: string, replace_all = false) => ({ old_string, new_string, replace_all });

test("Edit matches curly quotes and carries the matched quote styles into replacement", () => {
  assert.equal(applyEdit('say “hello” and ‘bye’', edit('"hello" and \'bye\'', '"welcome" and \'goodbye\'')), 'say “welcome” and ‘goodbye’');
  assert.equal(applyEdit('‘hello’', edit("'hello'", "'it's' ('new') [\"plain\"]")), '‘it’s’ (‘new’) ["plain"]');
  assert.equal(applyEdit('“hello”', edit('"hello"', '"one"—"two"\n"three"')), '“one”—“two”\n“three”');
  assert.equal(applyEdit('"hello"', edit('“hello”', '"plain"')), '"plain"');
});

test("Edit gives literal matches priority and counts the actual matched quote variant", () => {
  assert.equal(applyEdit('“one” "one"', edit('"one"', '"two"')), '“one” "two"');
  assert.equal(applyEdit('“one” ”one“', edit('"one"', '"two"', true)), '“two” ”one“');
  assert.throws(() => applyEdit('“one” “one”', edit('"one"', '"two"')), /Found 2 matches/);
  assert.equal(applyEdit('“one” “one”', edit('"one"', '"two"', true)), '“two” “two”');
});

test("Edit restores CRLF once when replacement already contains CRLF", () => {
  assert.equal(applyEdit('one\r\ntwo\r\n', edit('one\ntwo', 'new\r\nlines')), 'new\r\nlines\r\n');
  assert.equal(applyEdit('one\ntwo\r\nthree\n', edit('two\n', 'new\n')), 'one\nnew\nthree\n');
});

test("Edit resolves escaped Unicode in either direction and retains matched hexadecimal style", () => {
  assert.equal(applyEdit('café', edit('caf\\u00e9', 'caf\\u00e0')), 'cafà');
  assert.equal(applyEdit('caf\\u00E9', edit('café', 'caféà')), 'caf\\u00E9\\u00E0');
  assert.equal(applyEdit('caf\\u00e9', edit('café', 'caféà')), 'caf\\u00e9\\u00e0');
  assert.equal(applyEdit('\\uD83D\\uDE00', edit('😀', '😃')), '\\uD83D\\uDE03');
  assert.equal(applyEdit('é \\u00e9', edit('é', 'à', true)), 'à \\u00e9');
  assert.equal(applyEdit('\\u00e9 \\u00E9', edit('é', 'à', true)), '\\u00e0 \\u00E9');
  assert.throws(() => applyEdit('\\u00e9 \\u00e9', edit('é', 'à')), /Found 2 matches/);
});

test("Edit escape matching respects escaped backslashes and literal replacement text", () => {
  assert.throws(() => applyEdit('\\\\u00e9', edit('é', 'à')), /not found/);
  assert.throws(() => applyEdit('\\\\u00e9 \\u00e9', edit('é', 'à')), /not found/);
  assert.throws(() => applyEdit('\\u00e9\\', edit('é\\', 'à')), /not found/);
  assert.equal(applyEdit('\\\\\\u00e9', edit('é', 'à')), '\\\\\\u00e0');
  assert.equal(applyEdit('é', edit('\\u00e9', '\\\\u00e0 $&')), '\\\\u00e0 $&');
  assert.equal(applyEdit('a.b[\\u00e9]', edit('a.b[é]', '$&à')), '$&\\u00e0');
});

test("Edit with empty old_string replaces whitespace and refuses nonempty content", () => {
  assert.equal(applyEdit('', edit('', 'new')), 'new');
  assert.equal(applyEdit(' \t\n', edit('', 'new')), 'new');
  assert.equal(applyEdit('\uFEFF\r\n', edit('', 'one\ntwo')), '\uFEFFone\r\ntwo');
  assert.throws(() => applyEdit('existing', edit('', 'new')), /already exists|nonempty/i);
  assert.throws(() => applyEdit('', edit('', '')), /No changes/);
});

test("Edit creates missing parents with empty old_string and preserves prior-Read rules for existing files", async t => {
  const { cwd, run, file } = await fixture(t);
  assert.equal((await run('Edit', { file_path: 'nested/new', ...edit('', 'created') })).content, 'File edited');
  assert.equal(await readFile(path.join(cwd, 'nested/new'), 'utf8'), 'created');
  assert.equal((await run('Edit', { file_path: 'nested/new', ...edit('created', 'updated') })).content, 'File edited');
  await writeFile(file, ' \n');
  assert.equal((await run('Edit', { file_path: 'a', ...edit('', 'replacement') })).is_error, true);
  await run('Read', { file_path: 'a' });
  assert.equal((await run('Edit', { file_path: 'a', ...edit('', 'replacement') })).content, 'File edited');
  assert.equal((await run('Edit', { file_path: 'a', ...edit('', 'clobber') })).is_error, true);
  assert.equal(await readFile(file, 'utf8'), 'replacement');
  assert.equal((await run('Edit', { file_path: 'missing', ...edit('old', 'new') })).is_error, true);
});

test("Read supports BOM-marked UTF16LE, line windows, Unicode and BOM-only files", async t => {
  const { run, file } = await fixture(t);
  await writeFile(file, Buffer.from('\uFEFFcafé 😀\r\nsecond\uFEFFline\r\n', 'utf16le'));
  assert.equal((await run('Read', { file_path: 'a' })).content, '1\tcafé 😀\n2\tsecond\uFEFFline\n3\t');
  assert.equal((await run('Read', { file_path: 'a', offset: 2, limit: 1 })).content, '2\tsecond\uFEFFline');
  await writeFile(file, Buffer.from('\uFEFF', 'utf16le'));
  assert.equal((await run('Read', { file_path: 'a' })).content, '[empty file]');
});

test("UTF16 Read decodes a surrogate beyond the former byte-prefix boundary", async t => {
  const { run, file } = await fixture(t);
  const text = '\uFEFF' + 'x'.repeat(32763) + '\nhi😀';
  await writeFile(file, Buffer.from(text, 'utf16le'));
  const result = await run('Read', { file_path: 'a', offset: 2 });
  assert.equal(result.is_error, undefined);
  assert.equal(result.content, '2\thi😀');
  assert.equal((await run('Write', { file_path: 'a', content: 'no' })).is_error, true);
});

test("Read rejects malformed UTF16, UTF16BE and decoded NULs", async t => {
  const { run, file } = await fixture(t);
  for (const bytes of [
    Buffer.from([255, 254, 65]), Buffer.from([255, 254, 0, 216]),
    Buffer.from([255, 254, 0, 220]), Buffer.from([254, 255, 0, 65]),
    Buffer.from('\uFEFFtext\0tail', 'utf16le'),
  ]) {
    await writeFile(file, bytes);
    assert.equal((await run('Read', { file_path: 'a' })).is_error, true);
    assert.equal((await run('Write', { file_path: 'a', content: 'no' })).is_error, true);
    assert.deepEqual(await readFile(file), bytes);
  }
});

test("Edit and Write preserve UTF16LE, BOM and mode across consecutive changes", async t => {
  const { cwd, run, file } = await fixture(t);
  await writeFile(file, Buffer.from('\uFEFF“one”\r\n“one”\r\n', 'utf16le'));
  await chmod(file, 0o640);
  await run('Read', { file_path: 'a' });
  assert.equal((await run('Edit', { file_path: 'a', ...edit('"one"', '"two"', true) })).content, 'File edited');
  assert.deepEqual(await readFile(file), Buffer.from('\uFEFF“two”\r\n“two”\r\n', 'utf16le'));
  assert.equal((await run('Write', { file_path: 'a', content: 'next\n' })).content, 'File written');
  assert.deepEqual(await readFile(file), Buffer.from('\uFEFFnext\n', 'utf16le'));
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(cwd), ['a']);
  assert.equal((await run('Edit', { file_path: 'a', ...edit('next', 'done') })).content, 'File edited');
  assert.deepEqual(await readFile(file), Buffer.from('\uFEFFdone\n', 'utf16le'));
});

test("Write preserves existing UTF8 BOM, avoids duplicate BOM, and permits empty truncation", async t => {
  const { run, file } = await fixture(t);
  for (const encoding of ['utf8', 'utf16le'] as const) {
    await writeFile(file, Buffer.from('\uFEFForiginal', encoding));
    await run('Read', { file_path: 'a' });
    for (const content of ['next', '\uFEFFexplicit', '']) {
      assert.equal((await run('Write', { file_path: 'a', content })).content, 'File written');
      assert.deepEqual(await readFile(file), Buffer.from(content === '' || content.startsWith('\uFEFF') ? content : '\uFEFF' + content, encoding));
    }
  }
});

test("stale checks compare normalized text across encodings and reject actual UTF16 changes", async t => {
  const { run, file } = await fixture(t);
  await writeFile(file, 'one\ntwo\n');
  await run('Read', { file_path: 'a' });
  await writeFile(file, Buffer.from('\uFEFFone\r\ntwo\r\n', 'utf16le'));
  assert.equal((await run('Edit', { file_path: 'a', ...edit('one', 'ONE') })).content, 'File edited');
  await writeFile(file, Buffer.from('\uFEFFONE\r\nexternal\r\n', 'utf16le'));
  assert.equal((await run('Write', { file_path: 'a', content: 'no' })).is_error, true);
  assert.deepEqual(await readFile(file), Buffer.from('\uFEFFONE\r\nexternal\r\n', 'utf16le'));
});

test("invalid UTF16 replacement fails before committing and creation obeys plan/denial gates", async t => {
  const { cwd, run, file } = await fixture(t);
  const original = Buffer.from('\uFEFFone', 'utf16le');
  await writeFile(file, original);
  await run('Read', { file_path: 'a' });
  assert.equal((await run('Write', { file_path: 'a', content: '\uD800' })).is_error, true);
  assert.deepEqual(await readFile(file), original);
  assert.deepEqual(await readdir(cwd), ['a']);
  for (const mode of ['default', 'plan'] as const) {
    const tools = createTools({ cwd, mode, approve: async () => false });
    const result = await tools.execute({ type: 'tool_use', id: 'denied', name: 'Edit', input: { file_path: 'new/nested', ...edit('', 'no') } }, new AbortController().signal);
    assert.equal(result.is_error, true);
    assert.deepEqual(await readdir(cwd), ['a']);
  }
});
