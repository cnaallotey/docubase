<script setup>
// The page frame. The class names and structure match the default theme, because its stylesheet
// and script (search, tabs, copy buttons, playground, Ask AI) are reused as they are.
// Override this component by creating components/DocubaseLayout.vue in your Nuxt app.
const props = defineProps({
  site: { type: Object, required: true },
  page: { type: Object, required: true },
});
const config = computed(() => props.site.config);
const external = (href) => /^https?:/i.test(href);
const brandLetter = computed(() => (Array.from(String(config.value.title).trim())[0] || 'D').toUpperCase());
</script>

<template>
  <div>
    <a class="skip" href="#content">Skip to content</a>
    <header class="topbar">
      <button class="icon-btn nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <a class="brand" :href="config.base"><span class="brand-mark" aria-hidden="true">{{ brandLetter }}</span>{{ config.title }}</a>
      <div class="topbar-spacer" />
      <button v-if="config.assistant.enabled" class="ask-btn" type="button" aria-label="Ask the docs assistant">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
        <span class="label">Ask AI</span>
      </button>
      <button class="search-btn" type="button" aria-label="Search docs">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span class="label">Search</span><kbd>Ctrl K</kbd>
      </button>
      <nav class="toplinks" aria-label="Site links">
        <a v-for="link in config.links" :key="link.href" :href="link.href" :rel="external(link.href) ? 'noopener noreferrer' : undefined">{{ link.label }}</a>
      </nav>
      <button class="icon-btn theme-toggle" type="button" aria-label="Switch between light and dark theme">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg>
      </button>
    </header>
    <div class="shell">
      <aside id="sidebar" class="sidebar"><nav aria-label="Documentation"><DocubaseNav :items="site.tree" :current="page.url" /></nav></aside>
      <main id="content" class="content" tabindex="-1"><slot /></main>
      <DocubaseToc :page="page" />
    </div>
    <dialog v-if="config.assistant.enabled" id="ask-dialog" class="ask" aria-label="Ask the docs assistant">
      <form class="ask-form">
        <label class="ask-label" for="ask-input">Ask a question about these docs</label>
        <textarea id="ask-input" rows="3" :maxlength="config.assistant.maxQuestionLength" placeholder="How do I deploy to a subfolder?" />
        <div class="ask-actions"><span class="ask-note">Answers come from these docs and can be wrong. Check the linked pages.</span><button type="submit" class="ask-send">Ask</button></div>
        <div class="ask-answer" role="status" aria-live="polite" />
        <ul class="ask-sources" />
      </form>
    </dialog>
    <dialog id="search-dialog" class="search" aria-label="Search docs">
      <form method="dialog">
        <input type="search" placeholder="Search the docs" aria-label="Search the docs" autocomplete="off" spellcheck="false">
        <p class="search-status" role="status" />
        <ul class="search-results" />
      </form>
    </dialog>
  </div>
</template>
