<script setup>
// Recursive sidebar list. A group is open when it contains the current page.
const props = defineProps({
  items: { type: Array, required: true },
  current: { type: String, default: '' },
});

function contains(group) {
  return group.items.some((entry) => (entry.type === 'page' ? entry.url === props.current : contains(entry)));
}
</script>

<template>
  <ul>
    <li v-for="entry in items" :key="entry.type === 'page' ? entry.url : entry.label">
      <a v-if="entry.type === 'page'" :href="entry.url" :aria-current="entry.url === current ? 'page' : undefined">{{ entry.title }}</a>
      <details v-else :open="contains(entry)">
        <summary>{{ entry.label }}</summary>
        <DocubaseNav :items="entry.items" :current="current" />
      </details>
    </li>
  </ul>
</template>
