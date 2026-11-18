import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  memoryNameSlug,
  stampNewMemoryContent,
} from "../../src/memory-stamp.js";

const TOPIC = `---
name: user-role
description: the user's role
metadata:
  type: user
---

TAU_AUTO_MEMORY_TOPIC_BODY
`;

test("a new memory file gets node_type, originSessionId and modified", () => {
  const stamped = stampNewMemoryContent({
    content: TOPIC,
    sessionId: "52bebf2f-8bcb-433e-a335-a81aedbf9848",
    modified: "2026-11-18T22:43:41.729Z",
  });
  assert.equal(
    stamped,
    `---
name: user-role
description: "the user's role"
metadata:
  node_type: memory
  type: user
  originSessionId: 52bebf2f-8bcb-433e-a335-a81aedbf9848
  modified: 2026-11-18T22:43:41.729Z
---

TAU_AUTO_MEMORY_TOPIC_BODY
`,
  );
});

test("MEMORY.md index lines without frontmatter are unchanged", () => {
  const index = "- [User role](user_role.md) — TAU_AUTO_MEMORY_INDEX_LINE\n";
  assert.equal(
    stampNewMemoryContent({ content: index, sessionId: "x" }),
    index,
  );
});

test("an already-stamped file is left alone", () => {
  const once = stampNewMemoryContent({
    content: TOPIC,
    sessionId: "first",
    modified: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(
    stampNewMemoryContent({
      content: once,
      sessionId: "second",
      modified: "2026-02-02T00:00:00.000Z",
    }),
    once,
  );
});

test("memory names are kebab-slugged", () => {
  assert.equal(memoryNameSlug("User Role"), "user-role");
  assert.equal(memoryNameSlug("user-role"), "user-role");
});
