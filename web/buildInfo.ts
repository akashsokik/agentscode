import type { BuildInfo } from '../shared/buildInfo.ts';

/** Replaced at build time by vite.config.ts; absent when the page is loaded some other way. */
declare const __PODCODE_BUILD__: BuildInfo | undefined;

/** This page's build (version, commit, date), for Settings > About. */
export const BUILD: BuildInfo = typeof __PODCODE_BUILD__ !== 'undefined' ? __PODCODE_BUILD__ : { version: '', commit: '', date: '' };
