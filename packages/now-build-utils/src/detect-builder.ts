import { PackageJson, Builder, Config } from './types';
import minimatch from 'minimatch';

const src: string = 'package.json';
const config: Config = { zeroConfig: true };

// Static builders are special cased in `@now/static-build`
const BUILDERS = new Map<string, Builder>([
  ['next', { src, use: '@now/next', config }],
]);

const API_BUILDERS: Builder[] = [
  { src: 'api/**/*.js', use: '@now/node', config },
  { src: 'api/**/*.ts', use: '@now/node', config },
  { src: 'api/**/*.rs', use: '@now/rust', config },
  { src: 'api/**/*.go', use: '@now/go', config },
  { src: 'api/**/*.php', use: '@now/php', config },
  { src: 'api/**/*.py', use: '@now/python', config },
  { src: 'api/**/*.rb', use: '@now/ruby', config },
  { src: 'api/**/*.sh', use: '@now/bash', config },
];

export async function detectBuilder(pkg: PackageJson): Promise<Builder> {
  for (const [dependency, builder] of BUILDERS) {
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);

    // Return the builder when a dependency matches
    if (deps[dependency]) {
      return builder;
    }
  }

  // By default we'll choose the `static-build` builder
  return { src, use: '@now/static-build', config };
}

export async function detectApiBuilders(
  files: string[]
): Promise<Builder[] | null> {
  const builds = files.map(file => {
    return API_BUILDERS.find(({ src }): boolean => minimatch(file, src));
  });

  // We can use `new Set` here since `builds` contains references to `API_BUILDERS`
  const finishedBuilds = Array.from(new Set(builds.filter(Boolean)));
  return finishedBuilds.length > 0 ? (finishedBuilds as Builder[]) : null;
}
