<script lang="ts">
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { create, insertMultiple, search, type Orama } from '@orama/orama';
	import { flat, type DocSlug } from '#lib/nav.js';

	// Raw markdown of every docs page, loaded lazily when the modal first opens. Rooted at
	// the project so the `(docs)` route group's parentheses can't be read as a glob group.
	const sources = import.meta.glob('/src/routes/**/content.md', {
		query: '?raw',
		import: 'default'
	}) as Record<string, () => Promise<string>>;

	/** A searchable section; `anchor` is the heading id, empty for the top of a page. */
	type Doc = { title: string; page: string; content: string; slug: DocSlug; anchor: string };

	let open = $state(false);
	let query = $state('');
	let results = $state<Doc[]>([]);
	let selected = $state(0);
	let input = $state<HTMLInputElement | null>(null);

	let db: Orama<{
		title: 'string';
		page: 'string';
		content: 'string';
		slug: 'string';
		anchor: 'string';
	}> | null = null;

	/** Same slug rules as rehype-slug (github-slugger), for heading deep links. */
	function slugify(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s-]/gu, '')
			.trim()
			.replace(/\s/g, '-');
	}

	/** Split a page's markdown into heading-anchored sections, markdown mostly stripped. */
	function toSections(slug: DocSlug, pageTitle: string, markdown: string): Doc[] {
		const clean = (text: string) =>
			text
				.replace(/```[\s\S]*?```/g, ' ')
				.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
				.replace(/[`*_[\]()>#|-]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();

		// walked line by line so a `# comment` inside a code fence isn't read as a heading
		const sections: { level: number; heading: string; lines: string[] }[] = [
			{ level: 0, heading: pageTitle, lines: [] }
		];
		let inFence = false;
		for (const line of markdown.split('\n')) {
			if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
			const match = inFence ? null : /^(#{1,3}) (.*)$/.exec(line);
			if (match) sections.push({ level: match[1].length, heading: match[2], lines: [] });
			else sections[sections.length - 1].lines.push(line);
		}

		return sections
			.filter((section) => section.level > 0 || clean(section.lines.join('\n')))
			.map((section) => ({
				title: section.heading.replace(/`/g, ''),
				page: pageTitle,
				content: clean(section.lines.join('\n')),
				slug,
				anchor: section.level <= 1 ? '' : slugify(section.heading)
			}));
	}

	let indexing: Promise<void> | null = null;

	function buildIndex(): Promise<void> {
		indexing ??= (async () => {
			const docs: Doc[] = [];
			for (const [path, load] of Object.entries(sources)) {
				const slug = /([^/]+)\/content\.md$/.exec(path)?.[1];
				const item = flat.find((entry) => entry.slug === slug);
				if (item) docs.push(...toSections(item.slug, item.title, await load()));
			}
			const index = create({
				schema: {
					title: 'string',
					page: 'string',
					content: 'string',
					slug: 'string',
					anchor: 'string'
				} as const
			});
			insertMultiple(index, docs);
			db = index;
		})();
		return indexing;
	}

	async function runSearch() {
		if (!db || !query.trim()) {
			results = [];
			selected = 0;
			return;
		}
		const found = await search(db, {
			term: query,
			properties: ['title', 'content'],
			boost: { title: 3, page: 2 },
			tolerance: 1,
			limit: 8
		});
		results = found.hits.map((hit) => hit.document as Doc);
		selected = 0;
	}

	async function show() {
		open = true;
		query = '';
		results = [];
		await buildIndex();
		input?.focus();
		// whatever was typed while the index was still loading gets its results now
		await runSearch();
	}

	function pick(doc: Doc | undefined) {
		if (!doc) return;
		open = false;
		// goto() in SvelteKit 3 rejects anything that doesn't resolve to a route, so the
		// destination is built by resolve() right here rather than stored as a string
		void goto(doc.anchor ? resolve(`${doc.slug}#${doc.anchor}`) : resolve(`/(docs)/${doc.slug}`));
	}

	function onKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
			event.preventDefault();
			if (open) open = false;
			else void show();
		} else if (open && event.key === 'Escape') {
			open = false;
		}
	}

	function onListKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selected = Math.min(selected + 1, results.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (event.key === 'Enter') {
			pick(results[selected]);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<button
	type="button"
	onclick={show}
	class="flex items-center gap-2 rounded-full border border-vp-divider px-3 py-1.5 text-sm text-vp-fg-muted hover:border-brand dark:border-vpd-divider dark:text-vpd-fg-muted"
	aria-label="Search docs"
>
	<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
		<circle cx="11" cy="11" r="7" />
		<path d="m21 21-4.3-4.3" />
	</svg>
	<span class="hidden sm:inline">Search</span>
	<kbd class="hidden rounded bg-vp-bg-mute px-1.5 py-0.5 text-[11px] sm:inline dark:bg-vpd-bg-mute">
		⌘K
	</kbd>
</button>

{#if open}
	<div
		class="fixed inset-0 z-50 bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
		onclick={(event) => {
			if (event.target === event.currentTarget) open = false;
		}}
		role="presentation"
	>
		<div
			class="mx-auto max-w-xl overflow-hidden rounded-xl bg-vp-bg shadow-2xl dark:bg-vpd-bg-soft"
			role="dialog"
			aria-modal="true"
			aria-label="Search documentation"
		>
			<div class="flex items-center gap-3 border-b border-vp-divider px-4 dark:border-vpd-divider">
				<svg
					class="h-4 w-4 text-vp-fg-muted dark:text-vpd-fg-muted"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<circle cx="11" cy="11" r="7" />
					<path d="m21 21-4.3-4.3" />
				</svg>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					bind:this={input}
					bind:value={query}
					oninput={runSearch}
					onkeydown={onListKeydown}
					autofocus
					placeholder="Search docs…"
					class="w-full border-0 bg-transparent py-3.5 text-sm text-vp-fg-strong placeholder-vp-fg-muted focus:ring-0 dark:text-vpd-fg"
				/>
				<kbd class="rounded bg-vp-bg-mute px-1.5 py-0.5 text-[11px] dark:bg-vpd-bg-mute">esc</kbd>
			</div>

			{#if results.length}
				<ul class="max-h-80 overflow-y-auto p-2">
					{#each results as doc, index (doc.slug + doc.anchor + doc.title)}
						<li>
							<button
								type="button"
								onclick={() => pick(doc)}
								onmouseenter={() => (selected = index)}
								class="block w-full rounded-lg px-3 py-2.5 text-left {selected === index
									? 'bg-brand-solid text-white'
									: 'text-vp-fg dark:text-vpd-fg'}"
							>
								<span class="block text-sm font-medium">{doc.title}</span>
								<span
									class="block truncate text-xs {selected === index
										? 'text-white/80'
										: 'text-vp-fg-muted dark:text-vpd-fg-muted'}"
								>
									{doc.page} — {doc.content.slice(0, 90)}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if query.trim()}
				<p class="px-4 py-8 text-center text-sm text-vp-fg-muted dark:text-vpd-fg-muted">
					No results for “{query}”
				</p>
			{:else}
				<p class="px-4 py-8 text-center text-sm text-vp-fg-muted dark:text-vpd-fg-muted">
					Type to search the documentation
				</p>
			{/if}
		</div>
	</div>
{/if}
