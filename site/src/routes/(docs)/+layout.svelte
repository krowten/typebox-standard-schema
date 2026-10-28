<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { nav, findByRoute } from '#lib/nav.js';
	import { AUTHOR, OG_IMAGE, REPO_URL, SITE_URL, SITE_NAME } from '#lib/site.js';
	import PageMeta from '#lib/components/PageMeta.svelte';

	let { children, data } = $props();

	const location = $derived(findByRoute(page.route.id));
	// built in the script block so the tag holds one line, not the template's indentation
	const headTitle = $derived(
		location.current
			? `${location.current.headTitle ?? location.current.title} | ${SITE_NAME}`
			: SITE_NAME
	);

	const url = $derived(location.current ? `${SITE_URL}/${location.current.slug}` : SITE_URL);
	const updated = $derived(data.updated ? new Date(data.updated) : null);
	const editUrl = $derived(
		`${REPO_URL}/blob/main/site/src/routes/(docs)/${location.current?.slug}/content.md`
	);

	const jsonLd = $derived(
		location.current
			? [
					{
						'@context': 'https://schema.org',
						'@type': 'TechArticle',
						headline: location.current.headTitle ?? location.current.title,
						description: location.current.description,
						url,
						image: OG_IMAGE.url,
						inLanguage: 'en',
						...(data.updated ? { dateModified: data.updated } : {}),
						author: AUTHOR,
						publisher: AUTHOR,
						isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
						about: { '@type': 'SoftwareSourceCode', name: SITE_NAME, codeRepository: REPO_URL }
					},
					{
						'@context': 'https://schema.org',
						'@type': 'BreadcrumbList',
						itemListElement: [
							{ '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
							{ '@type': 'ListItem', position: 2, name: location.current.title, item: url }
						]
					}
				]
			: []
	);

	// ---- "On this page" outline, rebuilt on navigation ----
	type Heading = { id: string; text: string; level: number };
	let headings = $state<Heading[]>([]);
	let activeId = $state('');
	let sidebarOpen = $state(false);

	$effect(() => {
		void page.url.pathname; // retrigger on navigation
		sidebarOpen = false;
		const nodes = Array.from(
			document.querySelectorAll<HTMLElement>('.docs-prose h2, .docs-prose h3')
		);
		headings = nodes
			.filter((node) => node.id)
			.map((node) => ({
				id: node.id,
				text: node.textContent ?? '',
				level: node.tagName === 'H2' ? 2 : 3
			}));

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) activeId = entry.target.id;
				}
			},
			{ rootMargin: '-80px 0px -70% 0px' }
		);
		for (const node of nodes) observer.observe(node);
		return () => observer.disconnect();
	});
</script>

{#if location.current}
	<PageMeta
		title={headTitle}
		socialTitle={location.current.headTitle ?? location.current.title}
		description={location.current.description}
		{url}
		type="article"
		{jsonLd}
	/>
{/if}

<div class="mx-auto max-w-[1440px] lg:flex">
	<!-- sidebar -->
	<button
		type="button"
		class="flex w-full items-center gap-2 border-b border-vp-divider px-6 py-3 text-sm text-vp-fg-muted lg:hidden dark:border-vpd-divider dark:text-vpd-fg-muted"
		aria-expanded={sidebarOpen}
		aria-controls="docs-sidebar"
		onclick={() => (sidebarOpen = !sidebarOpen)}
	>
		<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M4 6h16M4 12h16M4 18h16" />
		</svg>
		Menu
	</button>

	<aside
		id="docs-sidebar"
		class="shrink-0 border-r border-vp-divider bg-vp-bg-soft px-6 py-8 lg:sticky lg:top-16 lg:block lg:h-[calc(100vh-4rem)] lg:w-64 lg:overflow-y-auto dark:border-vpd-divider dark:bg-vpd-bg-soft
			{sidebarOpen ? 'block' : 'hidden'}"
	>
		{#each nav as group (group.title)}
			<div class="mb-6">
				<p class="mb-2 text-sm font-semibold text-vp-fg-strong dark:text-vpd-fg">{group.title}</p>
				<ul class="space-y-1">
					{#each group.items as item (item.slug)}
						<li>
							<a
								href={resolve(`/(docs)/${item.slug}`)}
								class="block rounded-md px-2 py-1.5 text-sm {location.current?.slug === item.slug
									? 'bg-brand/10 font-medium text-brand'
									: 'text-vp-fg-muted hover:text-vp-fg-strong dark:text-vpd-fg-muted dark:hover:text-vpd-fg'}"
							>
								{item.title}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</aside>

	<!-- content -->
	<div class="min-w-0 flex-1 px-6 py-10 lg:px-14">
		<article class="docs-prose mx-auto max-w-3xl">
			{@render children()}
		</article>

		{#if updated}
			<p class="mx-auto mt-10 max-w-3xl text-xs text-vp-fg-muted dark:text-vpd-fg-muted">
				Last updated
				<time datetime={data.updated}>
					{updated.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })}
				</time>
				·
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external link to the source on GitHub, not an app route -->
				<a href={editUrl} class="hover:text-brand">Edit this page on GitHub</a>
			</p>
		{/if}

		<!-- prev / next -->
		<nav class="mx-auto mt-14 max-w-3xl border-t border-vp-divider pt-6 dark:border-vpd-divider">
			<div class="flex justify-between gap-4 text-sm">
				{#if location.prev}
					<a
						href={resolve(`/(docs)/${location.prev.slug}`)}
						class="group rounded-lg border border-vp-divider px-4 py-3 hover:border-brand dark:border-vpd-divider dark:hover:border-brand"
					>
						<span class="block text-xs text-vp-fg-muted dark:text-vpd-fg-muted">Previous</span>
						<span class="font-medium text-brand">← {location.prev.title}</span>
					</a>
				{:else}<span></span>{/if}
				{#if location.next}
					<a
						href={resolve(`/(docs)/${location.next.slug}`)}
						class="group rounded-lg border border-vp-divider px-4 py-3 text-right hover:border-brand dark:border-vpd-divider dark:hover:border-brand"
					>
						<span class="block text-xs text-vp-fg-muted dark:text-vpd-fg-muted">Next</span>
						<span class="font-medium text-brand">{location.next.title} →</span>
					</a>
				{/if}
			</div>
		</nav>
	</div>

	<!-- on this page -->
	<aside
		class="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto py-10 pr-6 xl:block"
	>
		{#if headings.length}
			<p
				class="mb-2 text-xs font-semibold tracking-wide text-vp-fg-strong uppercase dark:text-vpd-fg"
			>
				On this page
			</p>
			<ul class="space-y-1 border-l border-vp-divider text-sm dark:border-vpd-divider">
				{#each headings as heading (heading.id)}
					<li>
						<a
							href="#{heading.id}"
							class="-ml-px block border-l py-1 {heading.level === 3
								? 'pl-7'
								: 'pl-4'} {activeId === heading.id
								? 'border-brand text-brand'
								: 'border-transparent text-vp-fg-muted hover:text-vp-fg-strong dark:text-vpd-fg-muted dark:hover:text-vpd-fg'}"
						>
							{heading.text}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</aside>
</div>
