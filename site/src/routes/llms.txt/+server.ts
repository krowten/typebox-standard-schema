import { nav } from '#lib/nav.js';
import { NPM_URL, REPO_URL, SITE_DESCRIPTION, SITE_URL } from '#lib/site.js';

export const prerender = true;

/** Index for AI tools (llmstxt.org): what the package is and where each page lives. */
export function GET(): Response {
	const sections = nav
		.map(
			(group) =>
				`## ${group.title}\n\n${group.items
					.map((item) => `- [${item.title}](${SITE_URL}/${item.slug}): ${item.description}`)
					.join('\n')}`
		)
		.join('\n\n');

	const body = `# typebox-standard-schema

> ${SITE_DESCRIPTION}

Install \`typebox-standard-schema\` and import \`Type\` from it instead of \`typebox\`: every schema it builds carries \`~standard\`, so it can be passed wherever Zod or Valibot schemas are accepted. The whole documentation as one file: ${SITE_URL}/llms-full.txt. Source: ${REPO_URL}. Package: ${NPM_URL}.

${sections}
`;
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
