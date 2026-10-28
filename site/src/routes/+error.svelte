<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { flat } from '#lib/nav.js';
	import { SITE_NAME } from '#lib/site.js';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Something went wrong'} | {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="mx-auto max-w-2xl px-6 py-24">
	<p class="text-sm font-semibold text-brand">{page.status}</p>
	<h1 class="mt-2 text-3xl font-bold tracking-tight text-vp-fg-strong dark:text-vpd-fg">
		{notFound ? 'This page doesn’t exist' : 'Something went wrong'}
	</h1>
	<p class="mt-4 text-vp-fg-muted dark:text-vpd-fg-muted">
		{notFound
			? 'The link may be out of date. These are the docs pages there are:'
			: page.error?.message}
	</p>
	{#if notFound}
		<ul class="mt-6 grid gap-2 sm:grid-cols-2">
			{#each flat as item (item.slug)}
				<li>
					<a class="text-brand hover:underline" href={resolve(`/(docs)/${item.slug}`)}>
						{item.title}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
	<a
		href={resolve('/')}
		class="mt-10 inline-block rounded-full bg-brand-solid px-5 py-2 text-sm font-medium text-white"
	>
		Back to the start
	</a>
</section>
