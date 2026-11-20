<script setup>
const props = defineProps({ page: { type: Object, required: true } });
const headings = computed(() => props.page.headings.filter((h) => h.depth <= 3));
</script>

<template>
  <aside v-if="headings.length >= 2" class="toc" aria-label="On this page">
    <h2>On this page</h2>
    <ul>
      <li v-for="h in headings" :key="h.id" :class="`depth-${h.depth}`"><a :href="`#${h.id}`">{{ h.text }}</a></li>
    </ul>
  </aside>
</template>
