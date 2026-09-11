import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig([
  {
    entry: ['src/**/*.ts'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: { sourcemap: true, tsgo: true },
    unbundle: true,
    platform: 'neutral',
    external: ['node:async_hooks'],
  },
]);

export default config;
