const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/**
 * Monorepo Metro config.
 *
 * Metro resolves modules from the app directory only, so it will not find
 * `@platematch/shared` in the workspace root `node_modules` or read TypeScript
 * straight out of `packages/shared/src`. Both are configured explicitly here —
 * without `watchFolders` a change to the shared schemas requires a full
 * `--clear` restart.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Let Metro see the shared package and the hoisted root dependencies.
config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Resolve the shared package to its TypeScript source so the app and the API
// are always validated against the same schemas, with no build step in between.
config.resolver.extraNodeModules = {
  '@platematch/shared': path.resolve(workspaceRoot, 'packages/shared/src'),
};

// `resolveRequest` is what actually honours the mapping above, including the
// subpath imports (`@platematch/shared/schemas`).
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@platematch/shared') {
    return context.resolveRequest(context, path.resolve(workspaceRoot, 'packages/shared/src/index.ts'), platform);
  }
  if (moduleName.startsWith('@platematch/shared/')) {
    const subpath = moduleName.slice('@platematch/shared/'.length);
    return context.resolveRequest(
      context,
      path.resolve(workspaceRoot, 'packages/shared/src', subpath.endsWith('.js') ? subpath.slice(0, -3) + '.ts' : subpath),
      platform,
    );
  }
  return defaultResolveRequest ? defaultResolveRequest(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

// Shared package sources are .ts, and Metro must be told to treat them as such.
config.resolver.sourceExts = [...config.resolver.sourceExts, 'ts', 'tsx', 'cjs', 'mjs'];

module.exports = config;
