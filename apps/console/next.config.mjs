import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// File tracing has to start at the workspace root, not at this app. @flagship/core
// lives outside apps/console and is reached through a symlink; left to default,
// Next roots the trace here, follows the link out of the tree and omits the
// package from the standalone bundle, which then fails at runtime rather than at
// build time.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@flagship/core'],
  // Ships a server with only the modules it was traced to need, so the runtime
  // image needs no npm install and carries no build-time dependencies.
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
