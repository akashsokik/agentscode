import type { WalkthroughStep } from '../shared/types.ts';

/** The lines a code step quoted, as they read in the file now; undefined when the file is shorter. */
export function currentLines(text: string, start: number, end: number): string | undefined {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  if (end > lines.length) return undefined;
  return lines.slice(start - 1, end).join('\n');
}

/** Whether a code step's file has moved on since the walkthrough quoted it. */
export function codeChanged(step: WalkthroughStep, text: string): boolean {
  if (step.kind !== 'code' || !step.startLine || !step.endLine) return false;
  return currentLines(text, step.startLine, step.endLine) !== step.excerpt;
}

/** The message "Ask about this step" sends: the question, with enough of the step for the agent to find it. */
export function stepQuestion(walkthroughTitle: string, index: number, step: WalkthroughStep, question: string): string {
  const where = step.kind === 'code' && step.path ? ` (${step.path}:${step.startLine}-${step.endLine})`
    : step.kind === 'diff' && step.path ? ` (diff of ${step.path})`
    : '';
  return `About step ${index + 1} of your walkthrough "${walkthroughTitle}", "${step.title}"${where}:\n\n${question.trim()}`;
}
