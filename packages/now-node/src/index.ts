import { Assets, NccOptions } from '@zeit/ncc';
import { join, dirname, relative, resolve } from 'path';
import { NccWatcher } from '@zeit/ncc-watcher';
import {
  glob,
  download,
  FileBlob,
  FileFsRef,
  Files,
  Meta,
  createLambda,
  runNpmInstall,
  runPackageJsonScript,
  getNodeVersion,
  getSpawnOptions,
  PrepareCacheOptions,
  BuildOptions,
  shouldServe,
} from '@now/build-utils';
export { NowRequest, NowResponse } from './types';
import { makeLauncher } from './launcher';

interface CompilerConfig {
  includeFiles?: string | string[];
}

interface DownloadOptions {
  files: Files;
  entrypoint: string;
  workPath: string;
  meta: Meta;
}

const watchers: Map<string, NccWatcher> = new Map();

const LAUNCHER_FILENAME = '___now_launcher';
const BRIDGE_FILENAME = '___now_bridge';
const HELPERS_FILENAME = '___now_helpers';

function getWatcher(entrypoint: string, options: NccOptions): NccWatcher {
  let watcher = watchers.get(entrypoint);
  if (!watcher) {
    watcher = new NccWatcher(entrypoint, options);
    watchers.set(entrypoint, watcher);
  }
  return watcher;
}

function toBuffer(data: string | Buffer): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return data;
}

async function downloadInstallAndBundle({
  files,
  entrypoint,
  workPath,
  meta,
}: DownloadOptions) {
  console.log('downloading user files...');
  const downloadedFiles = await download(files, workPath, meta);

  console.log("installing dependencies for user's code...");
  const entrypointFsDirname = join(workPath, dirname(entrypoint));
  const nodeVersion = await getNodeVersion(entrypointFsDirname);
  const spawnOpts = getSpawnOptions(meta, nodeVersion);
  await runNpmInstall(entrypointFsDirname, ['--prefer-offline'], spawnOpts);

  const entrypointPath = downloadedFiles[entrypoint].fsPath;
  return { entrypointPath, entrypointFsDirname, nodeVersion, spawnOpts };
}

async function compile(
  workPath: string,
  entrypointPath: string,
  entrypoint: string,
  config: CompilerConfig,
  { isDev, filesChanged, filesRemoved }: Meta
): Promise<{ preparedFiles: Files; watch: string[] }> {
  const input = entrypointPath;

  const options: NccOptions = {
    sourceMap: true,
    sourceMapRegister: true,
    filterAssetBase: resolve(workPath),
  };
  let code: string;
  let map: string | undefined;
  let assets: Assets | undefined;
  let watch: string[] = [];
  if (isDev) {
    const watcher = getWatcher(entrypointPath, options);
    const result = await watcher.build(
      Array.isArray(filesChanged)
        ? filesChanged.map(f => join(workPath, f))
        : undefined,
      Array.isArray(filesRemoved)
        ? filesRemoved.map(f => join(workPath, f))
        : undefined
    );
    code = result.code;
    map = result.map;
    assets = result.assets;
    watch = [...result.files, ...result.dirs, ...result.missing]
      .filter(f => f.startsWith(workPath))
      .map(f => relative(workPath, f))
      .concat(Object.keys(assets || {}));
  } else {
    const ncc = require('@zeit/ncc');
    const result = await ncc(input, options);
    code = result.code;
    map = result.map;
    assets = result.assets;
  }

  if (!assets) assets = {};

  if (config && config.includeFiles) {
    const includeFiles =
      typeof config.includeFiles === 'string'
        ? [config.includeFiles]
        : config.includeFiles;

    for (const pattern of includeFiles) {
      const files = await glob(pattern, workPath);

      for (const assetName of Object.keys(files)) {
        const stream = files[assetName].toStream();
        const { mode } = files[assetName];
        const { data } = await FileBlob.fromStream({ stream });

        assets[assetName] = {
          source: toBuffer(data),
          permissions: mode,
        };
      }
    }
  }

  const preparedFiles: Files = {};
  preparedFiles[entrypoint] = new FileBlob({ data: code });

  if (map) {
    preparedFiles[`${entrypoint.replace('.ts', '.js')}.map`] = new FileBlob({
      data: toBuffer(map),
    });
  }

  // move all user code to 'user' subdirectory
  // eslint-disable-next-line no-restricted-syntax
  for (const assetName of Object.keys(assets)) {
    const { source: data, permissions: mode } = assets[assetName];
    const blob2 = new FileBlob({ data, mode });
    preparedFiles[join(dirname(entrypoint), assetName)] = blob2;
  }

  return { preparedFiles, watch };
}

export const version = 2;

export const config = {
  maxLambdaSize: '5mb',
};

export async function build({
  files,
  entrypoint,
  workPath,
  config,
  meta = {},
}: BuildOptions) {
  const shouldAddHelpers = !(config && config.helpers === false);

  const {
    entrypointPath,
    entrypointFsDirname,
    nodeVersion,
    spawnOpts,
  } = await downloadInstallAndBundle({
    files,
    entrypoint,
    workPath,
    meta,
  });

  console.log('running user script...');
  await runPackageJsonScript(entrypointFsDirname, 'now-build', spawnOpts);

  console.log('compiling entrypoint with ncc...');
  const { preparedFiles, watch } = await compile(
    workPath,
    entrypointPath,
    entrypoint,
    config,
    meta
  );

  const launcherFiles: Files = {
    [`${LAUNCHER_FILENAME}.js`]: new FileBlob({
      data: makeLauncher({
        entrypointPath: `./${entrypoint}`,
        bridgePath: `./${BRIDGE_FILENAME}`,
        helpersPath: `./${HELPERS_FILENAME}`,
        shouldAddHelpers,
      }),
    }),
    [`${BRIDGE_FILENAME}.js`]: new FileFsRef({
      fsPath: require('@now/node-bridge'),
    }),
  };

  if (shouldAddHelpers) {
    launcherFiles[`${HELPERS_FILENAME}.js`] = new FileFsRef({
      fsPath: join(__dirname, 'helpers.js'),
    });
  }

  // Use the system-installed version of `node` when running via `now dev`
  const runtime = meta.isDev ? 'nodejs' : nodeVersion.runtime;

  const lambda = await createLambda({
    files: {
      ...preparedFiles,
      ...launcherFiles,
    },
    handler: `${LAUNCHER_FILENAME}.launcher`,
    runtime,
  });

  const output = { [entrypoint]: lambda };
  const result = { output, watch };
  return result;
}

export async function prepareCache({ workPath }: PrepareCacheOptions) {
  return {
    ...(await glob('node_modules/**', workPath)),
    ...(await glob('package-lock.json', workPath)),
    ...(await glob('yarn.lock', workPath)),
  };
}

export { shouldServe };
