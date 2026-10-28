import { findByRoute } from '#lib/nav.js';
import { docSource, lastModified } from '#lib/server/lastmod.js';

export function load({ route }) {
	const slug = findByRoute(route.id).current?.slug;
	return { updated: slug ? lastModified(docSource(slug)) : null };
}
