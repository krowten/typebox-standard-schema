<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { GOOGLE_SITE_VERIFICATION } from '$app/env/public';
	import { resolve } from '$app/paths';
	import Search from '#lib/components/Search.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';

	let { children } = $props();

	// every route except the landing page is documentation
	// (route id, not pathname: the id doesn't change with the deploy base or while prerendering)
	const inDocs = $derived(page.route.id !== '/');
</script>

<svelte:head>
	<!-- description, canonical and og:* belong to the page: the landing sets its own, docs
	     pages take theirs from `nav.ts`. A copy here would ship two of each tag. -->
	<link rel="icon" href={favicon} />
	{#if GOOGLE_SITE_VERIFICATION}
		<meta name="google-site-verification" content={GOOGLE_SITE_VERIFICATION} />
	{/if}
</svelte:head>

<div class="min-h-screen bg-vp-bg text-vp-fg dark:bg-vpd-bg dark:text-vpd-fg">
	<header
		class="fixed inset-x-0 top-0 z-40 border-b border-vp-divider bg-vp-bg/90 backdrop-blur dark:border-vpd-divider dark:bg-vpd-bg/90"
	>
		<nav class="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
			<a href={resolve('/')} class="flex items-center gap-2.5 font-semibold">
				<!-- signature: the schema-bracket mark -->
				<span
					class="flex h-6 w-6 items-center justify-center rounded-md bg-brand-solid font-mono text-[13px] leading-none font-bold text-white"
					aria-hidden="true">&#123;&#125;</span
				>
				<span class="hidden whitespace-nowrap text-vp-fg-strong min-[480px]:inline dark:text-vpd-fg"
					>typebox-standard-schema</span
				>
			</a>

			<div class="ml-auto flex items-center gap-2 text-sm font-medium">
				<Search />
				<a
					href={resolve('/(docs)/introduction')}
					class="rounded-md px-3 py-2 {inDocs
						? 'text-brand'
						: 'text-vp-fg hover:text-brand dark:text-vpd-fg dark:hover:text-brand'}"
				>
					Docs
				</a>
				<a
					href="https://github.com/krowten/typebox-standard-schema"
					target="_blank"
					rel="noreferrer"
					class="rounded-md px-3 py-2 text-vp-fg hover:text-brand dark:text-vpd-fg dark:hover:text-brand"
				>
					GitHub
				</a>
				<a
					href="https://www.npmjs.com/package/typebox-standard-schema"
					target="_blank"
					rel="noreferrer"
					class="hidden rounded-md px-3 py-2 text-vp-fg hover:text-brand sm:block dark:text-vpd-fg dark:hover:text-brand"
				>
					npm
				</a>
				<ThemeToggle />
			</div>
		</nav>
	</header>

	<main class="pt-16">
		{@render children()}
	</main>
</div>
