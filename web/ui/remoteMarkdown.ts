import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

/**
 * A GitHub PR description's HTML (ACH-41): parsed (rehype-raw), then cleaned with GitHub's own
 * allow-list (rehype-sanitize's defaultSchema): no script, style, iframe or on* attributes, and
 * only safe URL protocols. Runs first, before highlighting and chips. Only Markdown's remote mode
 * uses it; every other caller keeps raw HTML out.
 */
export const githubHtmlPlugins = [rehypeRaw, [rehypeSanitize, defaultSchema]] as const;

/** Only http(s) links are followed, and only http(s) images become links (none is loaded). */
export function isWebUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
