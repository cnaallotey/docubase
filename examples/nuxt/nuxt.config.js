// The docs are the same folder the default theme uses. Only the theme differs.
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@docubase/nuxt'],
  docubase: { dir: '../docs' },
  telemetry: false,
});
