/**
 * Check GitHub Releases (or tags) for newer extension builds (public API, no token).
 */

export const DEFAULT_GITHUB_RELEASE_REPO = 'alanchanlp224/sommelier-assistant';

const RELEASE_ZIP_NAMES = ['sommelier-assistant.zip'];

const GITHUB_HEADERS: HeadersInit = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

export interface LatestReleaseInfo {
  version: string;
  releaseTitle: string;
  releaseHtmlUrl: string;
  zipBrowserDownloadUrl: string | null;
}

type GitHubReleaseJson = {
  tag_name: string;
  name: string;
  html_url: string;
  assets?: { name: string; browser_download_url: string }[];
};

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

function pickZipUrl(assets: GitHubReleaseJson['assets']): string | null {
  if (!assets?.length) return null;
  for (const a of assets) {
    if (RELEASE_ZIP_NAMES.includes(a.name)) return a.browser_download_url;
  }
  const z = assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
  return z?.browser_download_url ?? null;
}

function fromReleasePayload(data: GitHubReleaseJson): LatestReleaseInfo {
  const version = data.tag_name.trim().replace(/^v/i, '');
  return {
    version,
    releaseTitle: data.name || data.tag_name,
    releaseHtmlUrl: data.html_url,
    zipBrowserDownloadUrl: pickZipUrl(data.assets),
  };
}

/**
 * Latest published version from GitHub.
 * Uses /releases/latest when present; otherwise first entry from /releases;
 * otherwise newest /tags entry (no zip URL — attach zips to a GitHub Release).
 */
export async function fetchLatestRelease(repo: string): Promise<LatestReleaseInfo> {
  const base = `https://api.github.com/repos/${repo}`;

  const latestRes = await fetch(`${base}/releases/latest`, { headers: GITHUB_HEADERS });
  if (latestRes.ok) {
    return fromReleasePayload((await latestRes.json()) as GitHubReleaseJson);
  }
  if (latestRes.status !== 404) {
    throw new Error(
      `GitHub returned ${latestRes.status}. If the repo is private, the API is unavailable without a token.`
    );
  }

  const listRes = await fetch(`${base}/releases?per_page=15`, { headers: GITHUB_HEADERS });
  if (!listRes.ok) {
    throw new Error(
      `GitHub returned ${listRes.status} for releases list. Check that "${repo}" exists and is public.`
    );
  }
  const releases = (await listRes.json()) as GitHubReleaseJson[];
  if (Array.isArray(releases) && releases.length > 0) {
    return fromReleasePayload(releases[0]);
  }

  const tagsRes = await fetch(`${base}/tags?per_page=30`, { headers: GITHUB_HEADERS });
  if (!tagsRes.ok) {
    throw new Error(`GitHub returned ${tagsRes.status} for tags list.`);
  }
  const tags = (await tagsRes.json()) as { name: string }[];
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error(
      `No releases or tags found for "${repo}". Create a GitHub Release (or at least a version tag).`
    );
  }

  const tag = tags[0];
  const version = tag.name.trim().replace(/^v/i, '');
  const releasesPage = `https://github.com/${repo}/releases`;
  return {
    version,
    releaseTitle: tag.name,
    releaseHtmlUrl: releasesPage,
    zipBrowserDownloadUrl: null,
  };
}
