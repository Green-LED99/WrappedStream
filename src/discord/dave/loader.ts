import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DaveModule } from './types.js';

export type DaveArtifactPaths = {
  vendorDirectory: string;
  libdaveJavaScript: string;
  libdaveWasm: string;
  attemptedDirectories: string[];
};

let cachedModule: DaveModule | null = null;

export async function loadDaveModule(): Promise<DaveModule> {
  if (cachedModule) {
    return cachedModule;
  }

  const currentModuleDir = path.dirname(fileURLToPath(import.meta.url));
  const { vendorDirectory, libdaveJavaScript, libdaveWasm } =
    await resolveDaveArtifactPaths(currentModuleDir);

  const moduleUrl = pathToFileURL(libdaveJavaScript).href;
  const imported = (await import(moduleUrl)) as {
    default?: (options: unknown) => Promise<DaveModule>;
  };
  const factory = imported.default;

  if (!factory) {
    throw new Error('libdave.js did not export a default module factory.');
  }

  const wasmBinary = await readFile(libdaveWasm);
  cachedModule = await factory({
    wasmBinary,
    locateFile: (filename: string) => path.join(vendorDirectory, filename),
  });

  return cachedModule;
}

async function resolveDaveArtifactPaths(
  moduleDirectory: string
): Promise<DaveArtifactPaths> {
  const attemptedDirectories = uniqueDirectories([
    path.resolve(moduleDirectory, '../../../vendor/libdave'),
    path.resolve(moduleDirectory, '../../../../vendor/libdave'),
    path.resolve(process.cwd(), 'vendor/libdave'),
  ]);

  for (const vendorDirectory of attemptedDirectories) {
    const libdaveJavaScript = path.join(vendorDirectory, 'libdave.js');
    const libdaveWasm = path.join(vendorDirectory, 'libdave.wasm');

    if ((await fileExists(libdaveJavaScript)) && (await fileExists(libdaveWasm))) {
      return {
        vendorDirectory,
        libdaveJavaScript,
        libdaveWasm,
        attemptedDirectories,
      };
    }
  }

  throw new Error(
    `Missing libdave artifacts (libdave.js / libdave.wasm). Run the build-libdave script first. Searched: ${attemptedDirectories.join(', ')}`
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueDirectories(directories: string[]): string[] {
  return [...new Set(directories)];
}
