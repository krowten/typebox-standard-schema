<script lang="ts">
	import { OG_IMAGE, SITE_NAME } from '#lib/site.js';

	type Props = {
		/** The full `<title>`, keyword first and brand last. */
		title: string;
		/** The social-card title; the head title minus the brand suffix reads better there. */
		socialTitle?: string;
		description: string;
		url: string;
		type: 'website' | 'article';
		/** schema.org objects, emitted as one JSON-LD block. */
		jsonLd?: object[];
	};

	let { title, socialTitle = title, description, url, type, jsonLd = [] }: Props = $props();

	// a literal closing script tag would end the component's own <script> block
	const jsonLdTag = $derived(
		jsonLd.length
			? `<script type="application/ld+json">${JSON.stringify(jsonLd.length === 1 ? jsonLd[0] : jsonLd)}${'<'}/script>`
			: ''
	);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:type" content={type} />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:locale" content="en_US" />
	<meta property="og:title" content={socialTitle} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={OG_IMAGE.url} />
	<meta property="og:image:width" content={String(OG_IMAGE.width)} />
	<meta property="og:image:height" content={String(OG_IMAGE.height)} />
	<meta property="og:image:alt" content={OG_IMAGE.alt} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={socialTitle} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={OG_IMAGE.url} />
	<meta name="twitter:image:alt" content={OG_IMAGE.alt} />
	{#if jsonLdTag}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- JSON.stringify of our own constants, no user input -->
		{@html jsonLdTag}
	{/if}
</svelte:head>
