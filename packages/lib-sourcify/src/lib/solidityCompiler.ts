// TODO: Handle nodejs only dependencies
import path from 'path';
import fs from 'fs';
import { exec, spawnSync } from 'child_process';
import { fetchWithTimeout } from './utils';
import { StatusCodes } from 'http-status-codes';
import { JsonInput, PathBuffer } from './types';
import { logDebug, logError, logInfo, logWarn } from './logger';
import semver from 'semver';
import { Worker, WorkerOptions } from 'worker_threads';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require('solc');

const GITHUB_SOLC_REPO = 'https://github.com/ethereum/solc-bin/raw/gh-pages/';

export function findSolcPlatform(): string | false {
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'macosx-amd64';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'linux-amd64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'windows-amd64';
  }
  return false;
}
/**
 * Searches for a solc: first for a local executable version, then from GitHub
 * and then using the getSolcJs function.
 * Once the compiler is retrieved, it is used, and the stringified solc output is returned.
 *
 * @param version the version of solc to be used for compilation
 * @param input a JSON object of the standard-json format compatible with solc
 * @param log the logger
 * @returns stringified solc output
 */

export async function useCompiler(version: string, solcJsonInput: JsonInput) {
  // For nightly builds, Solidity version is saved as 0.8.17-ci.2022.8.9+commit.6b60524c instead of 0.8.17-nightly.2022.8.9+commit.6b60524c.
  // Not possible to retrieve compilers with "-ci.".
  if (version.includes('-ci.')) version = version.replace('-ci.', '-nightly.');
  const inputStringified = JSON.stringify(solcJsonInput);
  let compiled: string | undefined;

  const solcPlatform = findSolcPlatform();
  let solcPath;
  if (solcPlatform) {
    solcPath = await getSolcExecutable(solcPlatform, version);
  }
  let startCompilation: number;
  if (solcPath) {
    logDebug(`Compiling with solc binary ${version} at ${solcPath}`);
    startCompilation = Date.now();
    try {
      compiled = await asyncExecSolc(inputStringified, solcPath);
    } catch (error: any) {
      if (error?.code === 'ENOBUFS') {
        throw new Error('Compilation output size too large');
      }
      logWarn(error.message);
      throw error;
    }
  } else {
    const solJson = await getSolcJs(version);
    startCompilation = Date.now();
    logDebug(`Compiling with solc-js ${version}`);
    if (solJson) {
      const coercedVersion =
        semver.coerce(new semver.SemVer(version))?.version ?? '';
      // Run Worker for solc versions < 0.4.0 for clean compiler context. See https://github.com/ethereum/sourcify/issues/1099
      if (semver.lt(coercedVersion, '0.4.0')) {
        compiled = await new Promise((resolve, reject) => {
          const worker = importWorker(
            path.resolve(__dirname, './compilerWorker.ts'),
            {
              workerData: { version, inputStringified },
            }
          );
          worker.once('message', (result) => {
            resolve(result);
          });
          worker.once('error', (error) => {
            reject(error);
          });
        });
      } else {
        compiled = solJson.compile(inputStringified);
      }
    }
  }

  const endCompilation = Date.now();
  logInfo(`Compilation time : ${endCompilation - startCompilation} ms`);

  if (!compiled) {
    throw new Error('Compilation failed. No output from the compiler.');
  }
  const compiledJSON = JSON.parse(compiled);
  const errorMessages = compiledJSON?.errors?.filter(
    (e: any) => e.severity === 'error'
  );
  if (errorMessages && errorMessages.length > 0) {
    const error = new Error(
      'Compiler error:\n ' + JSON.stringify(errorMessages)
    );
    logError(error.message);
    throw error;
  }
  return compiledJSON;
}

export async function getAllMetadataAndSourcesFromSolcJson(
  solcJson: JsonInput,
  compilerVersion: string
): Promise<PathBuffer[]> {
  if (solcJson.language !== 'Solidity')
    throw new Error(
      'Only Solidity is supported, the json has language: ' + solcJson.language
    );

  const outputSelection = {
    '*': {
      '*': ['metadata'],
    },
  };
  if (!solcJson.settings) {
    solcJson.settings = {
      outputSelection: outputSelection,
    };
  }
  solcJson.settings.outputSelection = outputSelection;
  const compiled = await useCompiler(compilerVersion, solcJson);
  const metadataAndSources: PathBuffer[] = [];
  if (!compiled.contracts)
    throw new Error('No contracts found in the compiled json output');
  for (const contractPath in compiled.contracts) {
    for (const contract in compiled.contracts[contractPath]) {
      const metadata = compiled.contracts[contractPath][contract].metadata;
      const metadataPath = `${contractPath}-metadata.json`;
      metadataAndSources.push({
        path: metadataPath,
        buffer: Buffer.from(metadata),
      });
      metadataAndSources.push({
        path: `${contractPath}`,
        buffer: Buffer.from(solcJson.sources[contractPath].content as string),
      });
    }
  }
  return metadataAndSources;
}

export async function getSolcExecutable(
  platform: string,
  version: string
): Promise<string | null> {
  const fileName = `solc-${platform}-v${version}`;
  const repoPath = process.env.SOLC_REPO || path.join('/tmp', 'solc-repo');
  const solcPath = path.join(repoPath, fileName);
  if (fs.existsSync(solcPath) && validateSolcPath(solcPath)) {
    logDebug(`Found solc ${version} with platform ${platform} at ${solcPath}`);
    return solcPath;
  }

  logDebug(
    `Downloading solc ${version} with platform ${platform} at ${solcPath}`
  );
  const success = await fetchAndSaveSolc(platform, solcPath, version, fileName);
  logDebug(
    `Downloaded solc ${version} with platform ${platform} at ${solcPath}`
  );
  if (success && !validateSolcPath(solcPath)) {
    logError(`Cannot validate solc ${version}.`);
    return null;
  }
  return success ? solcPath : null;
}

function validateSolcPath(solcPath: string): boolean {
  // TODO: Handle nodejs only dependencies
  const spawned = spawnSync(solcPath, ['--version']);
  if (spawned.status === 0) {
    return true;
  }

  const error =
    spawned?.error?.message ||
    spawned.stderr.toString() ||
    'Error running solc, are you on the right platoform? (e.g. x64 vs arm)';

  logWarn(error);
  return false;
}

/**
 * Fetches a solc binary from GitHub and saves it to the given path.
 *
 * If platform is "bin", it will download the solc-js binary.
 */
async function fetchAndSaveSolc(
  platform: string,
  solcPath: string,
  version: string,
  fileName: string
): Promise<boolean> {
  const encodedURIFilename = encodeURIComponent(fileName);
  const githubSolcURI = `${GITHUB_SOLC_REPO}${platform}/${encodedURIFilename}`;
  logDebug(
    `Fetching solc ${version} on platform ${platform} from GitHub: ${githubSolcURI}`
  );
  let res = await fetchWithTimeout(githubSolcURI);
  let status = res.status;
  let buffer;

  // handle case in which the response is a link to another version
  if (status === StatusCodes.OK) {
    buffer = await res.arrayBuffer();
    const responseText = Buffer.from(buffer).toString();
    if (
      /^([\w-]+)-v(\d+\.\d+\.\d+)\+commit\.([a-fA-F0-9]+).*$/.test(responseText)
    ) {
      const githubSolcURI = `${GITHUB_SOLC_REPO}${platform}/${responseText}`;
      res = await fetchWithTimeout(githubSolcURI);
      status = res.status;
      buffer = await res.arrayBuffer();
    }
  }

  if (status === StatusCodes.OK && buffer) {
    logDebug(
      `Fetched solc ${version} on platform ${platform} from GitHub: ${githubSolcURI}`
    );
    fs.mkdirSync(path.dirname(solcPath), { recursive: true });

    try {
      fs.unlinkSync(solcPath);
    } catch (_e) {
      undefined;
    }
    fs.writeFileSync(solcPath, new DataView(buffer), { mode: 0o755 });

    return true;
  } else {
    logWarn(`Failed fetching solc ${version} from GitHub: ${githubSolcURI}`);
  }

  return false;
}

/**
 * Fetches the requested version of the Solidity compiler (soljson).
 * First attempts to search locally; if that fails, falls back to downloading it.
 *
 * @param version the solc version to retrieve: the expected format is
 *
 * "[v]<major>.<minor>.<patch>+commit.<hash>"
 *
 * e.g.: "0.6.6+commit.6c089d02"
 *
 * defaults to "latest"
 *
 * @param log a logger to track the course of events
 *
 * @returns the requested solc instance
 */
export async function getSolcJs(version = 'latest'): Promise<any> {
  // /^\d+\.\d+\.\d+\+commit\.[a-f0-9]{8}$/
  version = version.trim();
  if (version !== 'latest' && !version.startsWith('v')) {
    version = 'v' + version;
  }

  const soljsonRepo =
    process.env.SOLJSON_REPO || path.join('/tmp', 'soljson-repo');
  const fileName = `soljson-${version}.js`;
  const soljsonPath = path.resolve(soljsonRepo, fileName);

  if (!fs.existsSync(soljsonPath)) {
    if (!(await fetchAndSaveSolc('bin', soljsonPath, version, fileName))) {
      return false;
    }
  }

  const solcjsImports = await import(soljsonPath);
  return solc.setupMethods(solcjsImports);
}

function asyncExecSolc(
  inputStringified: string,
  solcPath: string
): Promise<string> {
  // check if input is valid JSON. The input is untrusted and potentially cause arbitrary execution.
  JSON.parse(inputStringified);

  return new Promise((resolve, reject) => {
    const child = exec(
      `${solcPath} --standard-json`,
      {
        maxBuffer: 1000 * 1000 * 10,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else if (stderr) {
          reject(
            new Error(`Compiler process returned with errors:\n ${stderr}`)
          );
        } else {
          resolve(stdout);
        }
      }
    );
    if (!child.stdin) {
      throw new Error('No stdin on child process');
    }
    // Write input to child process's stdin
    child.stdin.write(inputStringified);
    child.stdin.end();
  });
}

// https://stackoverflow.com/questions/71795469/ts-node-using-worker-thread-cause-cannot-use-import-statement-outside-a-module
function importWorker(path: string, options: WorkerOptions) {
  const resolvedPath = require.resolve(path);
  return new Worker(resolvedPath, {
    ...options,
    execArgv: /\.ts$/.test(resolvedPath)
      ? ['--require', 'ts-node/register']
      : undefined,
  });
}
