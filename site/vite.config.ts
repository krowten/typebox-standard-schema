import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { mdsvex, escapeSvelte } from 'mdsvex';
import rehypeSlug from 'rehype-slug';
import { createHighlighter } from 'shiki';

// one highlighter for the whole build; dual themes switch via CSS variables
const highlighter = await createHighlighter({
	themes: ['github-light', 'github-dark'],
	langs: ['typescript', 'javascript', 'bash', 'json', 'html', 'css', 'yaml', 'tsx', 'vue']
});

// '/typebox-standard-schema' on GitHub Pages (project page), '' locally
const BASE_PATH = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

type MdNode = { type?: string; url?: string; children?: MdNode[] };

/** Prefix root-absolute link/image urls in markdown with the deploy base path. */
function remarkBasePath() {
	return (tree: MdNode) => {
		if (!BASE_PATH) return;
		const walk = (node: MdNode) => {
			if ((node.type === 'link' || node.type === 'image') && node.url?.startsWith('/')) {
				node.url = BASE_PATH + node.url;
			}
			node.children?.forEach(walk);
		};
		walk(tree);
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			extensions: ['.svelte', '.md'],
			paths: { base: BASE_PATH },
			preprocess: [
				mdsvex({
					extensions: ['.md'],
					remarkPlugins: [remarkBasePath],
					rehypePlugins: [rehypeSlug],
					highlight: {
						highlighter: (code, lang) => {
							const html = highlighter.codeToHtml(code, {
								lang: lang ?? 'text',
								themes: { light: 'github-light', dark: 'github-dark' },
								defaultColor: false
							});
							return `{@html \`${escapeSvelte(html)}\`}`;
						}
					}
				})
			],
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// the docs site is fully static (GitHub Pages). GitHub Pages serves 404.html for any
			// unknown path; as a SPA fallback it boots the client router, which renders
			// +error.svelte with the docs index
			adapter: adapter({ fallback: '404.html' }),
			// sitemap.xml is linked from robots.txt only, so the crawler never finds it on its own
			prerender: { entries: ['*', '/sitemap.xml'] }
		})
	]
});
