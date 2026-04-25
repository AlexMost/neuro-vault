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

export function buildOperationsTools(handlers: OperationsToolHandlers): ToolRegistration[] {
  return [
    {
      name: 'read_note',
      spec: {
        title: 'Read Note',
        description:
          'Read a note\'s contents. Provide either `name` (wikilink-style, resolves like Obsidian) or `path` (vault-relative, exact). Returns `{ path, content }`.',
        inputSchema: readNoteSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.readNote(readNoteSchema.parse(args))),
    },
    {
      name: 'create_note',
      spec: {
        title: 'Create Note',
        description:
          'Create a new note. Provide `name` or `path`. Optional `content` and `template`. If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
        inputSchema: createNoteSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.createNote(createNoteSchema.parse(args))),
    },
    {
      name: 'edit_note',
      spec: {
        title: 'Edit Note',
        description:
          'Add content to an existing note at the start (`prepend`) or end (`append`). Use \\n for newlines.',
        inputSchema: editNoteSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.editNote(editNoteSchema.parse(args))),
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
  ];
}
