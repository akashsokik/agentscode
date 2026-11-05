import type { Scenario } from '../scenario.ts';
import { appError } from './app-error.ts';
import { changelog } from './changelog.ts';
import { filesChanged } from './files-changed.ts';
import { generatedConfig } from './generated-config.ts';
import { implicitFix } from './implicit-fix.ts';
import { multiLesson } from './multi-lesson.ts';
import { passingPreference } from './passing-preference.ts';
import { silentFailure } from './silent-failure.ts';
import { spdxHeader } from './spdx-header.ts';
import { specDir } from './spec-dir.ts';
import { tabsIndent } from './tabs-indent.ts';
import { testCommand } from './test-command.ts';

/**
 * Lessons the engines do not follow by default, and that neither the system prompt nor a usual
 * ~/.claude/CLAUDE.md states (so not "no emojis").
 * - explicit: a plain correction. Real agents save these themselves with remember (8/8 in the first run).
 * - hard: lessons agents rarely save on their own, where dreaming has room to help.
 */
export const SCENARIOS: Scenario[] = [
  // hard
  implicitFix,
  silentFailure,
  multiLesson,
  passingPreference,
  // explicit
  tabsIndent,
  testCommand,
  changelog,
  spdxHeader,
  specDir,
  filesChanged,
  appError,
  generatedConfig,
];
