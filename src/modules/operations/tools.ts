import { z } from 'zod';

import { invokeTool } from '../../lib/tool-response.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { OperationsToolHandlers } from './types.js';

const noteIdentifierShape = {
  name: z.string().optional(),
  path: z.string().optional(),
};

const readNotesFieldSchema = z.enum(['frontmatter', 'content']);
const readNotesSchema = z.object({
  paths: z.array(z.string()).min(1).max(50),
  fields: z.array(readNotesFieldSchema).min(1).optional(),
});

const createNoteSchema = z.object({
  ...noteIdentifierShape,
  content: z.string().optional(),
  template: z.string().optional(),
  overwrite: z.boolean().optional(),
});

const editNoteSchema = z.object({
  ...noteIdentifierShape,
  content: z.string(),
  position: z.enum(['append', 'prepend']),
});

const readDailySchema = z.object({});

const appendDailySchema = z.object({
  content: z.string(),
});

const setPropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]),
  type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).optional(),
});

const readPropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
});

const removePropertySchema = z.object({
  ...noteIdentifierShape,
  key: z.string(),
});

const listPropertiesSchema = z.object({});
const listTagsSchema = z.object({});

const getTagSchema = z.object({
  tag: z.string(),
  include_files: z.boolean().optional(),
});

export function buildOperationsTools(handlers: OperationsToolHandlers): ToolRegistration[] {
  return [
    {
      name: 'read_notes',
      spec: {
        title: 'Read Notes',
        description:
          "Read multiple notes in one call. `paths` is an array of 1–50 vault-relative POSIX paths; duplicates are de-duplicated and results returned in input order. `fields` projects which parts of each note to return — choose from `frontmatter` and `content`; default `['frontmatter','content']`. One missing or unreadable path does not fail the others — per-item errors come back inline. A single MCP roundtrip with parallel disk reads. Reads are direct from disk and do not require Obsidian to be running.",
        inputSchema: readNotesSchema,
      },
      handler: async (args) => invokeTool(() => handlers.readNotes(readNotesSchema.parse(args))),
    },
    {
      name: 'create_note',
      spec: {
        title: 'Create Note',
        description:
          'Create a new note. Provide `name` or `path`. Optional `content` and `template`. If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
        inputSchema: createNoteSchema,
      },
      handler: async (args) => invokeTool(() => handlers.createNote(createNoteSchema.parse(args))),
    },
    {
      name: 'edit_note',
      spec: {
        title: 'Edit Note',
        description:
          'Add content to an existing note at the start (`prepend`) or end (`append`). Use \\n for newlines.',
        inputSchema: editNoteSchema,
      },
      handler: async (args) => invokeTool(() => handlers.editNote(editNoteSchema.parse(args))),
    },
    {
      name: 'read_daily',
      spec: {
        title: 'Read Daily',
        description:
          "Read today's daily note. Returns `{ path, frontmatter, content }` where `frontmatter` is the parsed YAML object (or `null` if absent/malformed) and `content` is the body without the YAML block. Useful for 'what's on my agenda?' questions.",
        inputSchema: readDailySchema,
      },
      handler: async () => invokeTool(() => handlers.readDaily({})),
    },
    {
      name: 'append_daily',
      spec: {
        title: 'Append Daily',
        description:
          "Append content to today's daily note. Use \\n for newlines. Common uses: log a thought, add a task, mark progress.",
        inputSchema: appendDailySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.appendDaily(appendDailySchema.parse(args))),
    },
    {
      name: 'set_property',
      spec: {
        title: 'Set Property',
        description:
          'Set a frontmatter property on a note. Provide either `name` (wikilink-style) or `path` (vault-relative). `key` is the frontmatter property name (e.g. `status`, `due`). `value` may be string/number/boolean/array — `type` is inferred from the JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly AND use ISO format (`YYYY-MM-DD` for date, `YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]` for datetime) — non-ISO values are silently dropped by obsidian-cli, so this tool rejects them up front. List items must not contain commas (obsidian-cli limitation). Existing properties are overwritten.',
        inputSchema: setPropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.setProperty(setPropertySchema.parse(args))),
    },
    {
      name: 'read_property',
      spec: {
        title: 'Read Property',
        description:
          'Read a frontmatter property value from a note. Provide `name` or `path`, plus `key`. Returns `{ value }`. Use `read_notes` if you need the full frontmatter or accurate type information.',
        inputSchema: readPropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.readProperty(readPropertySchema.parse(args))),
    },
    {
      name: 'remove_property',
      spec: {
        title: 'Remove Property',
        description:
          'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed.',
        inputSchema: removePropertySchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.removeProperty(removePropertySchema.parse(args))),
    },
    {
      name: 'list_properties',
      spec: {
        title: 'List Properties',
        description:
          "List all frontmatter properties used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`. Useful for understanding the vault's metadata ontology.",
        inputSchema: listPropertiesSchema,
      },
      handler: async () => invokeTool(() => handlers.listProperties({})),
    },
    {
      name: 'list_tags',
      spec: {
        title: 'List Tags',
        description:
          'List all tags used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`.',
        inputSchema: listTagsSchema,
      },
      handler: async () => invokeTool(() => handlers.listTags({})),
    },
    {
      name: 'get_tag',
      spec: {
        title: 'Get Tag',
        description:
          'Get info about one tag. Provide `tag` (with or without the leading `#` — both `ai` and `#ai` work). Returns `{ name, count }` where `name` is the stripped tag string, plus `files: string[]` by default. Pass `include_files: false` for popular tags where the file list would be large.',
        inputSchema: getTagSchema,
      },
      handler: async (args) => invokeTool(() => handlers.getTag(getTagSchema.parse(args))),
    },
  ];
}
