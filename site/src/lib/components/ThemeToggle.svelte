<script lang="ts">
	// initialised in the browser only — during prerender there is no documentElement state
	let dark = $derived(
		typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
	);

	function toggle() {
		dark = !dark;
		document.documentElement.classList.toggle('dark', dark);
		localStorage.theme = dark ? 'dark' : 'light';
	}
</script>

<button
	type="button"
	onclick={toggle}
	class="rounded-md p-2 text-vp-fg-muted hover:text-vp-fg-strong dark:text-vpd-fg-muted dark:hover:text-vpd-fg"
	aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
>
	{#if dark}
		<!-- sun -->
		<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<circle cx="12" cy="12" r="4" />
			<path
				d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
			/>
		</svg>
	{:else}
		<!-- moon -->
		<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
		</svg>
	{/if}
</button>
