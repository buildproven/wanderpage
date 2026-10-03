// @design DES-CLI-LAUNCH
type Table = Record<string, string>;
export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  type?: string;
  bin?: Table;
  engines?: Table;
  scripts?: Table;
  dependencies?: Table;
  devDependencies?: Table;
};
export type LocalManifest = PackageManifest & { private: true; scripts: Table; dependencies: Table; devDependencies: Table };
export const notCopied: Set<string>;
export function localEdition(pkg: PackageManifest): LocalManifest;
export function nodeVersionProblem(version: string): string | undefined;
