import { flat } from '#lib/nav.js';
import { pageMarkdown } from '#lib/server/llms.js';
import { SITE_URL } from '#lib/site.js';

export const prerender = true;

/** Every docs page in one markdown file, for AI tools that read a library's docs whole. */
export function GET(): Response {
	const body = flat
		.map((item) => `<!-- ${SITE_URL}/${item.slug} -->\n\n${pageMarkdown(item.slug).trim()}`)
		.join('\n\n---\n\n');
	return new Response(`${body}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
