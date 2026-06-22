const config = {
  plugins: {
    // Tailwind v4's PostCSS plugin bundles `@import` itself (resolving
    // node_modules packages via their `exports` map), so `postcss-import`
    // is intentionally omitted — it would resolve subpaths like
    // `@thaddeus/theme/style.css` against the package root and miss `dist/`.
    '@tailwindcss/postcss': {},
  },
};

export default config;
