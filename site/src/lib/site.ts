/** Canonical origin of the deployed docs site (GitHub Pages project page). */
export const SITE_URL = 'https://krowten.github.io/typebox-standard-schema';

export const SITE_NAME = 'typebox-standard-schema';

/**
 * Landing page metadata; docs pages carry theirs in `nav.ts`. The keyword leads and the
 * brand trails, matching the docs titles, and the description stays inside the ~155
 * characters a search result shows.
 */
export const SITE_TITLE = 'TypeBox Standard Schema Validator | typebox-standard-schema';
export const SITE_DESCRIPTION =
	'Make every TypeBox 1.x schema a Standard Schema validator for tRPC, Hono, Elysia and TanStack Form, with readOnly/writeOnly projections and JSON Schema.';

export const REPO_URL = 'https://github.com/krowten/typebox-standard-schema';
export const NPM_URL = 'https://www.npmjs.com/package/typebox-standard-schema';

/** Social card shared by every page: 1200×630, the size Open Graph and X both expect. */
export const OG_IMAGE = {
	url: `${SITE_URL}/og.png`,
	width: 1200,
	height: 630,
	alt: 'typebox-standard-schema — Standard Schema for TypeBox with read/write projections'
};

/** Who stands behind the docs, for structured data. */
export const AUTHOR = { '@type': 'Person', name: 'krowten', url: 'https://github.com/krowten' };
