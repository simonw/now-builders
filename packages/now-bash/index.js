const execa = require('execa');
const { join } = require('path');
const snakeCase = require('snake-case');
const {
  glob,
  download,
  createLambda,
  getWriteableDirectory,
  shouldServe,
} = require('@now/build-utils'); // eslint-disable-line import/no-extraneous-dependencies

exports.config = {
  maxLambdaSize: '10mb',
};

// From this list: https://import.pw/importpw/import/docs/config.md
const allowedConfigImports = new Set([
  'CACHE',
  'CURL_OPTS',
  'DEBUG',
  'RELOAD',
  'SERVER',
]);

exports.analyze = ({ files, entrypoint }) => files[entrypoint].digest;

exports.build = async ({
  workPath, files, entrypoint, config,
}) => {
  const srcDir = await getWriteableDirectory();

  console.log('downloading files...');
  await download(files, srcDir);

  const configEnv = Object.keys(config).reduce((o, v) => {
    const name = snakeCase(v).toUpperCase();

    if (allowedConfigImports.has(name)) {
      o[`IMPORT_${name}`] = config[v]; // eslint-disable-line no-param-reassign
    }

    return o;
  }, {});

  if (config && config.import) {
    Object.keys(config.import).forEach((key) => {
      const name = snakeCase(key).toUpperCase();
      // eslint-disable-next-line no-param-reassign
      configEnv[`IMPORT_${name}`] = config.import[key];
    });
  }

  const IMPORT_CACHE = `${workPath}/.import-cache`;
  const env = Object.assign({}, process.env, configEnv, {
    PATH: `${IMPORT_CACHE}/bin:${process.env.PATH}`,
    IMPORT_CACHE,
    SRC: srcDir,
    BUILDER: __dirname,
    ENTRYPOINT: entrypoint,
  });

  const builderPath = join(__dirname, 'builder.sh');

  await execa(builderPath, [entrypoint], {
    env,
    cwd: workPath,
    stdio: 'inherit',
  });

  const lambda = await createLambda({
    files: await glob('**', workPath),
    handler: entrypoint, // not actually used in `bootstrap`
    runtime: 'provided',
    environment: Object.assign({}, configEnv, {
      SCRIPT_FILENAME: entrypoint,
    }),
  });

  return {
    [entrypoint]: lambda,
  };
};

exports.shouldServe = shouldServe;
