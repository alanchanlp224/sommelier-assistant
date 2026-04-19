/**
 * Check GitHub Releases for newer extension builds (public API, no token).
 */

export const DEFAULT_GITHUB_RELEASE_REPO = 'alanchanlp224/sommelier-assistant';

const RELEASE_ZIP_NAMES = ['sommelier-assistant.zip'];

export interface LatestReleaseInfo {
  version: string;
  releaseTitle: string;
  releaseHtmlUrl: string;
  zipBrowserDownloadUrl: string | null;
}

/** Parse "1.2.3" or "v1.2.3" or "1.2.3-beta" → numeric triple. */
export function parseSemverCore(version: string): [number, number, number] | null {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** -1 if a < b, 0 if equal, 1 if a > b (invalid strings compare as equal). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Latest GitHub release metadata for the given owner/repo. */
export async function fetchLatestRelease(repo: string): Promise<LatestReleaseInfo> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    name: string;
    html_url: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  const version = data.tag_name.trim().replace(/^v/i, '');
  let zipBrowserDownloadUrl: string | null = null;
  for (const a of data.assets ?? []) {
    if (RELEASE_ZIP_NAMES.includes(a.name)) {
      zipBrowserDownloadUrl = a.browser_download_url;
      break;
    }
  }
  if (!zipBrowserDownloadUrl && data.assets?.length) {
    const z = data.assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
    if (z) zipBrowserDownloadUrl = z.browser_download_url;
  }
  return {
    version,
    releaseTitle: data.name,
    releaseHtmlUrl: data.html_url,
    zipBrowserDownloadUrl,
  };
}
