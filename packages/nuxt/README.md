# @docubase/nuxt

A Nuxt module that renders a folder of Markdown as docs, using `@docubase/core`.

```bash
npm install nuxt @docubase/nuxt
```

```js
export default defineNuxtConfig({
  modules: ['@docubase/nuxt'],
  docubase: { dir: './docs' }
});
```

Run `nuxt dev` or `nuxt generate`. Replace `DocubaseLayout`, `DocubaseNav`, `DocubaseToc` or `DocubasePager` by adding a component with the same name to your app. Full guide: https://docubase.clientra.tech/docs/guides/nuxt/
