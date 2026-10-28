import { readFileSync } from 'node:fs';

import { SITE_URL } from '#lib/site.js';
import { docSource } from '#lib/server/lastmod.js';

/** A docs page's markdown with site-relative links made absolute, for readers outside the site. */
export function pageMarkdown(slug: string): string {
	return readFileSync(docSource(slug), 'utf8').replace(/\]\(\/(?!\/)/g, `](${SITE_URL}/`);
}
