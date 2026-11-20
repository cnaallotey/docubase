<script setup>
defineProps({ page: { type: Object, required: true } });
</script>

<template>
  <nav v-if="page.prev || page.next" class="pager" aria-label="Pagination">
    <a v-if="page.prev" class="prev" :href="page.prev.url" rel="prev"><small>Previous</small>{{ page.prev.title }}</a>
    <a v-if="page.next" class="next" :href="page.next.url" rel="next"><small>Next</small>{{ page.next.title }}</a>
  </nav>
</template>
