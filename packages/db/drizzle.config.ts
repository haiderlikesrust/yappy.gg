import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Points at the *built* schema, not the TypeScript source. drizzle-kit's
  // bundler does not resolve NodeNext-style `./foo.js` specifiers back to
  // `./foo.ts`, which every import in src/schema uses. Running `tsc` first and
  // pointing the generator at dist sidesteps it without contorting the source.
  schema: './dist/schema/index.js',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
