import { flat } from '#lib/nav.js';
import { SITE_URL } from '#lib/site.js';
import { docSource, lastModified } from '#lib/server/lastmod.js';

export const prerender = true;

/**
 * Static sitemap for the prerendered docs site. A project page can't serve the host's
 * robots.txt, so search engines learn about this file from Search Console, not robots.txt.
 */
export function GET(): Response {
	const entries = [
		{ loc: SITE_URL, lastmod: lastModified('src/routes/+page.svelte') },
		...flat.map((item) => ({
			loc: `${SITE_URL}/${item.slug}`,
			lastmod: lastModified(docSource(item.slug))
		}))
	];
	const urls = entries
		.map(({ loc, lastmod }) => `\t<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`)
		.join('\n');

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
	return new Response(body, { headers: { 'content-type': 'application/xml' } });
}
