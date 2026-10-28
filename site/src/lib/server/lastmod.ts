import { execFileSync } from 'node:child_process';

/** Where a docs page's content lives, relative to the project root. */
export const docSource = (slug: string): string => `src/routes/(docs)/${slug}/content.md`;

/**
 * ISO date of the last commit that touched `file`, for the sitemap's `lastmod` and a page's
 * `dateModified`. Outside a git checkout it falls back to the build time. A shallow clone
 * would date every file to the same single commit, which is why the docs workflow checks
 * out the full history.
 */
export function lastModified(file: string): string {
	try {
		const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
			encoding: 'utf8'
		}).trim();
		if (date) return date;
	} catch {
		// not a git checkout
	}
	return new Date().toISOString();
}
