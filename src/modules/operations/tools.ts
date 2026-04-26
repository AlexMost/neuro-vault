import { z } from 'zod';

import { invokeTool } from '../../lib/tool-response.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { OperationsToolHandlers } from './types.js';

const noteIdentifierShape = {
  name: z.string().optional(),
  path: z.string().optional(),
};

const readNoteSchema = z.object(noteIdentifierShape);

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

const propertyTargetShape = {
  file: z.string().optional(),
  path: z.string().optional(),
};

const setPropertySchema = z.object({
  ...propertyTargetShape,
  name: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
  ]),
  type: z.enum(['text', 'list', 'number', 'checkbox', 'date', 'datetime']).optional(),
});

const readPropertySchema = z.object({
  ...propertyTargetShape,
  name: z.string(),
});

const removePropertySchema = z.object({
  ...propertyTargetShape,
  name: z.string(),
});

const listPropertiesSchema = z.object({});
const listTagsSchema = z.object({});

const getTagSchema = z.object({
  name: z.string(),
  include_files: z.boolean().optional(),
});

export function buildOperationsTools(handlers: OperationsToolHandlers): ToolRegistration[] {
  return [
    {
      name: 'read_note',
      spec: {
        title: 'Read Note',
        description:
          "Read a note's contents. Provide either `name` (wikilink-style, resolves like Obsidian) or `path` (vault-relative, exact). Returns `{ path, content }`.",
        inputSchema: readNoteSchema,
      },
      handler: async (args) => invokeTool(() => handlers.readNote(readNoteSchema.parse(args))),
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
          "Read today's daily note. Returns `{ path, content }`. Useful for 'what's on my agenda?' questions.",
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
          'Set a frontmatter property on a note. Provide either `file` (wikilink-style) or `path` (vault-relative). `value` may be string/number/boolean/array — `type` is inferred from the JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly. Existing properties are overwritten.',
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
          'Read a frontmatter property value from a note. Returns `{ value }`. Use `read_note` if you need the full frontmatter or accurate type information.',
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
          'Remove a frontmatter property from a note. Idempotent — succeeds whether or not the property existed.',
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
          'Get info about one tag. Returns `{name, count}` and (by default) `files: string[]`. Pass `include_files: false` for popular tags where the file list would be large.',
        inputSchema: getTagSchema,
      },
      handler: async (args) => invokeTool(() => handlers.getTag(getTagSchema.parse(args))),
    },
  ];
}
