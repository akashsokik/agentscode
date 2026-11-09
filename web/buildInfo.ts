import type { BuildInfo } from '../shared/buildInfo.ts';

/** Replaced at build time by vite.config.ts; absent when the page is loaded some other way. */
declare const __AGENTSCODE_BUILD__: BuildInfo | undefined;

/** This page's build (version, commit, date), for Settings > About. */
export const BUILD: BuildInfo = typeof __AGENTSCODE_BUILD__ !== 'undefined' ? __AGENTSCODE_BUILD__ : { version: '', commit: '', date: '' };
