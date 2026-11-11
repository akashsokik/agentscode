import { createLibrary, defineComponent } from '@openuidev/lang-core';
import { OPENUI_COMPONENTS, OPENUI_ROOT } from '../shared/openui.ts';

// What an agent reads before it puts interactive UI in a reply: OpenUI's own prompt for the
// PodCode library, in inline mode (prose with ```openui-lang blocks), built once on demand.

const PREAMBLE = [
  'In PodCode your replies are Markdown, and you may add interactive UI to them in ```openui-lang code blocks.',
  'Use it when it helps the user see or decide something: a status summary, metrics, a table of results, a chart, choices to click.',
  'Keep explanations in prose; put only the UI in the block. PodCode draws it in its own theme, so never set colours.',
].join(' ');

const RULES = [
  'Every block starts with root = Stack([...]) and stands alone: always write the whole program, never only changed statements. Earlier blocks in the conversation are not updated.',
  'Clicking a Button sends its label to you as the user\'s next message (or the message its action gives). Phrase labels as the reply you expect, e.g. "Run the tests".',
  'Table rows are arrays of cells in column order; keep tables under 50 rows.',
  'For flows, sequences and architecture, a Diagram (Mermaid) is usually clearer than a Chart.',
];

const EXAMPLES = [
  `Here is where the release stands:

\`\`\`openui-lang
root = Stack([summary, tests, next])
summary = Stack([builds, failing], "row")
builds = Metric("Builds today", 14, "+3")
failing = Metric("Failing tests", 2, null, "both in auth")
tests = Table(["Test", "Status", "Time"], [["login", "failed", "1.2s"], ["signup", "passed", "0.8s"]])
next = Buttons([fix, skip])
fix = Button("Fix the failing tests", null, "primary")
skip = Button("Ship without them", null, "secondary")
\`\`\``,
];

let library: ReturnType<typeof createLibrary> | null = null;
let cached: string | null = null;

/** The library without renderers: enough for the prompt and for parsing programs. */
export function openuiLibrary() {
  library ??= createLibrary({
    root: OPENUI_ROOT,
    components: Object.entries(OPENUI_COMPONENTS).map(([name, spec]) => defineComponent({ name, props: spec.props, description: spec.description, component: null })),
  });
  return library;
}

export function openuiGuide(): string {
  if (cached) return cached;
  cached = openuiLibrary().prompt({ inlineMode: true, preamble: PREAMBLE, additionalRules: RULES, examples: EXAMPLES, toolCalls: false, bindings: false });
  return cached;
}
