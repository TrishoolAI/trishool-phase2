/**
 * Encodes semver (major.minor.patch) like alignet `__spec_version__`:
 * `1000 * major + 10 * minor + patch` (see alignet/__init__.py).
 */
export function semverToAlignetSpecVersion(version: string): number | null {
  const trimmed = version.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((n) => Number.isFinite(n))) {
    return null;
  }
  return 1000 * major + 10 * minor + patch;
}
