import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildCatalogAttachments,
  catalogSkillDigest,
  type CatalogHistoryAttachment,
  type CatalogProjectionOptions,
  type SkillCatalogAttachment,
} from "../../src/catalog-projection.js";
const base = (): CatalogProjectionOptions => ({
  hasAgentTool: true,
  hasSkillTool: true,
  history: [],
  agents: [
    {
      agentType: "owned:reader",
      whenToUse: "Read owned fixtures",
      tools: ["Read", "Write"],
      disallowedTools: ["Write"],
      source: "plugin",
    },
  ],
  skills: [{ name: "owned:prepare", description: "Prepare owned fixture" }],
});
const history = (
  value: ReturnType<typeof buildCatalogAttachments>,
): CatalogHistoryAttachment[] => value.attachments;
const skill = (
  value: ReturnType<typeof buildCatalogAttachments>,
): SkillCatalogAttachment | undefined => {
  for (const row of value.attachments)
    if (row.type === "skill_listing") return row;
  return undefined;
};
const requiredSkill = (value: ReturnType<typeof buildCatalogAttachments>) => {
  const row = skill(value);
  assert.ok(row);
  return row;
};
const blockText = (
  value: ReturnType<typeof buildCatalogAttachments>,
  index: number,
) => {
  const block = value.blocks[index];
  assert.ok(block);
  return block.text;
};
const baseSkill = () => {
  const [definition] = base().skills;
  assert.ok(definition);
  return definition;
};

test("catalog metadata projects separate user text blocks in agent then skill order", () => {
  const result = buildCatalogAttachments(base());
  assert.deepEqual(
    result.blocks.map((block) => block.kind),
    ["agent", "skill"],
  );
  assert.match(
    blockText(result, 0),
    /<system-reminder>\n.*Agent[\s\S]*owned:reader/,
  );
  assert.match(blockText(result, 0), /Tools: Read/);
  assert.match(blockText(result, 1), /owned:prepare: Prepare owned fixture/);
  assert.deepEqual(
    result.attachments.map((row) => row.type),
    ["agent_listing_delta", "skill_listing"],
  );
  assert.equal(result.attachments[0]?.isInitial, true);
});
test("prepare is pure; only explicit committed history suppresses future catalog emissions", () => {
  const options = base(),
    first = buildCatalogAttachments(options);
  assert.deepEqual(buildCatalogAttachments(options), first);
  assert.deepEqual(
    buildCatalogAttachments({ ...options, history: history(first) })
      .attachments,
    [],
  );
});
test("agent updates use name presence, emit removed names, and return to initial after removal", () => {
  const first = buildCatalogAttachments(base()),
    saved = history(first);
  const changed = buildCatalogAttachments({
    ...base(),
    history: saved,
    agents: [{ agentType: "owned:reader", whenToUse: "Changed description" }],
  });
  assert.deepEqual(changed.attachments, []);
  const removed = buildCatalogAttachments({
    ...base(),
    history: saved,
    agents: [],
  });
  const [delta] = removed.attachments;
  assert.ok(delta);
  assert.equal(delta.type, "agent_listing_delta");
  if (delta.type !== "agent_listing_delta") throw Error("Expected agent delta");
  assert.deepEqual(delta.removedTypes, ["owned:reader"]);
  assert.equal(delta.isInitial, false);
  assert.match(blockText(removed, 0), /removed/);
  const restored = buildCatalogAttachments({
    ...base(),
    history: [...saved, ...history(removed)],
  });
  assert.equal(restored.attachments[0]?.isInitial, true);
});
test("malformed legacy addedTypes without addedLines does not mark an agent as seen", () => {
  const result = buildCatalogAttachments({
    ...base(),
    history: [{ type: "agent_listing_delta", addedTypes: ["owned:reader"] }],
  });
  assert.equal(result.attachments[0]?.isInitial, true);
});
test("skill digest tracks display name and description metadata but not body/model/tools", () => {
  const definition = baseSkill(),
    digest = catalogSkillDigest(definition);
  assert.equal(digest.length, 16);
  assert.notEqual(
    catalogSkillDigest({ ...definition, displayName: "Pretty" }),
    digest,
  );
  assert.notEqual(
    catalogSkillDigest({ ...definition, whenToUse: "For fixtures" }),
    digest,
  );
  assert.equal(
    catalogSkillDigest({
      ...definition,
      description: "ignored",
      listingDescription: definition.description,
    }),
    digest,
  );
  const first = buildCatalogAttachments(base());
  const refreshed = buildCatalogAttachments({
    ...base(),
    history: history(first),
    additiveSkillRefresh: true,
    skills: [{ ...definition, description: "Changed description" }],
  });
  assert.equal(requiredSkill(refreshed).isInitial, false);
  assert.equal(requiredSkill(refreshed).addsToEarlier, true);
  assert.deepEqual(requiredSkill(refreshed).names, [definition.name]);
});
test("legacy missing digest suppresses all new descriptions; skills have no removal delta", () => {
  const prior: CatalogHistoryAttachment[] = [
    { type: "skill_listing", names: ["owned:prepare"], isInitial: true },
  ];
  assert.equal(
    skill(buildCatalogAttachments({ ...base(), history: prior })),
    undefined,
  );
  const first = buildCatalogAttachments(base());
  const removed = buildCatalogAttachments({
    ...base(),
    skills: [],
    history: history(first),
  });
  assert.deepEqual(removed.attachments, []);
  assert.equal(
    skill(buildCatalogAttachments({ ...base(), history: history(first) })),
    undefined,
  );
});
test("feature-enabled legacy nonadditive refresh resets earlier skill history without including the reset record", () => {
  const definition = baseSkill();
  const prior: CatalogHistoryAttachment[] = [
    {
      type: "skill_listing",
      names: [definition.name],
      digests: [catalogSkillDigest(definition)],
      isInitial: true,
    },
    {
      type: "skill_listing",
      names: [definition.name],
      digests: [catalogSkillDigest(definition)],
      isInitial: false,
    },
  ];
  assert.equal(
    skill(
      buildCatalogAttachments({
        ...base(),
        history: prior,
        additiveSkillRefresh: false,
      }),
    ),
    undefined,
  );
  assert.equal(
    requiredSkill(
      buildCatalogAttachments({
        ...base(),
        history: prior,
        additiveSkillRefresh: true,
      }),
    ).isInitial,
    true,
  );
});
test("priority budget keeps all names and collapses descriptions without reordering; bundled rows are fixed absent remaining cap", () => {
  const options = {
    ...base(),
    agents: [],
    skills: [
      { name: "one", description: "description" },
      { name: "two", description: "description" },
      { name: "three", description: "description", bundled: true },
    ],
    skillBudget: {
      override: 40,
      measure: (text: string) => text.length,
      priority: (name: string) => (name === "two" ? 100 : 0),
    },
  };
  const result = requiredSkill(buildCatalogAttachments(options));
  assert.equal(result.content, "- one\n- two\n- three: description");
  // remaining cap makes bundled descriptions eligible for collapse and sets shortened only when output changes.
  const capped = requiredSkill(
    buildCatalogAttachments({
      ...options,
      skillBudget: { ...options.skillBudget, remaining: 20 },
    }),
  );
  assert.equal(capped.content, "- one\n- two\n- three");
  assert.equal(capped.shortened, true);
  assert.deepEqual(capped.names, ["one", "two", "three"]);
});
test("description clipping and name-only entries retain identity and direct-call metadata", () => {
  const result = requiredSkill(
    buildCatalogAttachments({
      ...base(),
      skills: [
        { name: "long", description: "abcdefgh" },
        { name: "only", description: "hidden description", nameOnly: true },
      ],
      callsSkillToolDirectly: true,
      skillBudget: { maxDescriptionChars: 5 },
    }),
  );
  assert.equal(result.content, "- long: abcd…\n- only");
  assert.equal(result.callsSkillToolDirectly, true);
});
test("tool availability and host suppression prevent catalogs; no admission occurs in formatter", () => {
  assert.deepEqual(
    buildCatalogAttachments({
      ...base(),
      hasAgentTool: false,
      hasSkillTool: false,
    }).attachments,
    [],
  );
  assert.deepEqual(
    buildCatalogAttachments({ ...base(), agents: [], suppressSkills: true })
      .attachments,
    [],
  );
  assert.throws(
    () => buildCatalogAttachments({ ...base(), skillBudget: { override: -1 } }),
    RangeError,
  );
});

test("agent additions use source ASCII locale ordering while removals use JS code-unit sort", () => {
  const options = {
    ...base(),
    skills: [],
    agents: [
      { agentType: "Z", whenToUse: "upper" },
      { agentType: "a", whenToUse: "lower" },
    ],
  };
  const [first] = buildCatalogAttachments(options).attachments;
  assert.ok(first);
  assert.equal(first.type, "agent_listing_delta");
  if (first.type !== "agent_listing_delta")
    throw Error("Expected agent catalog");
  assert.deepEqual(first.addedTypes, ["a", "Z"]);
  const [removed] = buildCatalogAttachments({
    ...options,
    agents: [],
    history: [first],
  }).attachments;
  assert.ok(removed);
  if (removed.type !== "agent_listing_delta")
    throw Error("Expected agent catalog");
  assert.deepEqual(removed.removedTypes, ["Z", "a"]);
});
