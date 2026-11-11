import { action } from '@openuidev/lang-core';
import { z } from 'zod';

// PodCode's OpenUI component library, as schemas: the props each component takes and what it is
// for. The server builds the agents' guide from these (server/openuiGuide.ts); the web app draws
// them in the app's own theme (web/openui/library.tsx). Same names and props on both sides.

export { OPENUI_FENCES } from './openuiFences.ts';

const nodes = z.array(z.any());
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const OPENUI_COMPONENTS = {
  Stack: {
    description: 'Root layout. Children in a column (default) or a row; rows wrap on narrow screens.',
    props: z.object({
      children: nodes,
      direction: z.enum(['column', 'row']).optional(),
      gap: z.enum(['s', 'm', 'l']).optional(),
    }),
  },
  Card: {
    description: 'A bordered panel grouping related content, with an optional title.',
    props: z.object({ title: z.string().optional(), children: nodes }),
  },
  Heading: {
    description: 'A heading. level 1 is largest; default 2.',
    props: z.object({ text: z.string(), level: z.number().int().min(1).max(3).optional() }),
  },
  Text: {
    description: 'A paragraph of plain text. tone "muted" for secondary text.',
    props: z.object({ text: z.string(), tone: z.enum(['normal', 'muted']).optional() }),
  },
  Metric: {
    description: 'One number at a glance: a label, a big value, an optional change (e.g. "+12%") and hint.',
    props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), delta: z.string().optional(), hint: z.string().optional() }),
  },
  Table: {
    description: 'Rows of data under column headers. Each row is an array of cells in column order. The user can sort by clicking a header.',
    props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(cell)) }),
  },
  Chart: {
    description: 'A bar or line chart. labels are the x-axis categories; each series has one value per label.',
    props: z.object({
      kind: z.enum(['bar', 'line']),
      title: z.string().optional(),
      labels: z.array(z.string()),
      series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
      yLabel: z.string().optional(),
    }),
  },
  Diagram: {
    description: 'A Mermaid diagram (flowchart, sequenceDiagram, architecture-beta, classDiagram, erDiagram, ...). source is the Mermaid text without a fence.',
    props: z.object({ source: z.string() }),
  },
  List: {
    description: 'A bulleted or numbered list of short items.',
    props: z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
  },
  Status: {
    description: 'A short status with a dot: success, warning, danger, info or neutral.',
    props: z.object({ label: z.string(), tone: z.enum(['success', 'warning', 'danger', 'info', 'neutral']) }),
  },
  Progress: {
    description: 'A progress bar: value out of max (default 100), with a label.',
    props: z.object({ label: z.string(), value: z.number(), max: z.number().positive().optional() }),
  },
  Code: {
    description: 'A block of code or command output.',
    props: z.object({ code: z.string(), language: z.string().optional() }),
  },
  Button: {
    description: 'A button. Its action usually sends a message back to you, the agent, as the user\'s reply (the label, or the message you give). primary for the main choice.',
    props: z.object({ label: z.string(), action: action().optional(), variant: z.enum(['primary', 'secondary']).optional() }),
  },
  Buttons: {
    description: 'A row of Button components, e.g. choices for the user.',
    props: z.object({ buttons: nodes }),
  },
} as const;

export type OpenUIComponentName = keyof typeof OPENUI_COMPONENTS;
export const OPENUI_ROOT: OpenUIComponentName = 'Stack';
