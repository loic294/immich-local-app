/**
 * Cloudflare Worker: Tauri updater proxy for a PRIVATE GitHub releases repo.
 *
 * The Tauri updater fetches update metadata over plain HTTPS GET and cannot
 * attach GitHub credentials to private asset URLs. This Worker holds a
 * read-only GitHub token server-side and:
 *   1. GET /:target/:arch/:current_version  -> Tauri update JSON (or 204)
 *   2. GET /download/:assetId               -> streams the private release asset
 *
 * Required environment (set via `wrangler secret put` / vars):
 *   - GH_TOKEN     : fine-grained PAT with read-only "Contents" on the repo (secret)
 *   - GITHUB_REPO  : "owner/name" of the private releases repo (var)
 *
 * No secret is ever sent to the app; the app only talks to this Worker.
 */

const LOG_PREFIX = "[updater-proxy]";

interface Env {
  GH_TOKEN: string;
  GITHUB_REPO: string;
}

interface GithubAsset {
  id: number;
  name: string;
  url: string;
}

interface GithubRelease {
  tag_name: string;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

const GITHUB_API = "https://api.github.com";

function githubHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "immich-local-app-updater",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Strip a leading "v" and split into numeric components for comparison. */
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** Returns true when `candidate` is strictly greater than `current`. */
function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

/**
 * Pick the main updater asset for a target/arch plus its `.sig` companion.
 * Tauri artifact names:
 *   - macOS:   <name>_<version>_<arch>.app.tar.gz            (arch: aarch64 | x64)
 *              or <name>_<version>_universal.app.tar.gz
 *   - Windows: <name>_<version>_<arch>-setup.exe             (NSIS, arch: x64)
 */
function selectAsset(
  assets: GithubAsset[],
  target: string,
  arch: string,
): { main: GithubAsset; sig: GithubAsset } | null {
  const sigs = new Map<string, GithubAsset>();
  for (const asset of assets) {
    if (asset.name.endsWith(".sig")) {
      sigs.set(asset.name.slice(0, -".sig".length), asset);
    }
  }

  const archAliases: Record<string, string[]> = {
    x86_64: ["x86_64", "x64"],
    aarch64: ["aarch64", "arm64"],
    i686: ["i686", "x86"],
    armv7: ["armv7"],
  };
  const aliases = archAliases[arch] ?? [arch];

  const matchesArch = (name: string) =>
    aliases.some((alias) => name.toLowerCase().includes(alias)) ||
    name.toLowerCase().includes("universal");

  let main: GithubAsset | undefined;
  if (target === "darwin") {
    const candidates = assets.filter((a) => a.name.endsWith(".app.tar.gz"));
    main =
      candidates.find((a) => matchesArch(a.name)) ??
      candidates.find((a) => a.name.toLowerCase().includes("universal"));
  } else if (target === "windows") {
    const candidates = assets.filter(
      (a) => a.name.endsWith("-setup.exe") || a.name.endsWith(".msi"),
    );
    // Never fall back across architectures: serving an x64 installer to an
    // arm64 machine (or vice versa) causes boot crashes under emulation.
    main = candidates.find((a) => matchesArch(a.name));
  } else if (target === "linux") {
    const candidates = assets.filter((a) => a.name.endsWith(".AppImage"));
    main = candidates.find((a) => matchesArch(a.name)) ?? candidates[0];
  }

  if (!main) {
    return null;
  }
  const sig = sigs.get(main.name);
  if (!sig) {
    return null;
  }
  return { main, sig };
}

/** Fetch the raw bytes/text of a private release asset via the GitHub API. */
async function fetchAssetBody(env: Env, assetId: number): Promise<Response> {
  return fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/assets/${assetId}`,
    {
      headers: {
        ...githubHeaders(env),
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    },
  );
}

async function handleManifest(
  env: Env,
  origin: string,
  target: string,
  arch: string,
  currentVersion: string,
): Promise<Response> {
  const releaseResponse = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/releases/latest`,
    { headers: githubHeaders(env) },
  );

  if (!releaseResponse.ok) {
    console.error(
      `${LOG_PREFIX} github latest release failed status=${releaseResponse.status}`,
    );
    return new Response("Failed to query releases", { status: 502 });
  }

  const release = (await releaseResponse.json()) as GithubRelease;
  const latestVersion = release.tag_name.replace(/^v/i, "");

  if (!isNewer(latestVersion, currentVersion)) {
    console.log(
      `${LOG_PREFIX} up-to-date target=${target} arch=${arch} current=${currentVersion} latest=${latestVersion}`,
    );
    return new Response(null, { status: 204 });
  }

  const picked = selectAsset(release.assets, target, arch);
  if (!picked) {
    console.error(
      `${LOG_PREFIX} no asset for target=${target} arch=${arch} version=${latestVersion}`,
    );
    return new Response("No matching asset for platform", { status: 404 });
  }

  // The signature must be the CONTENT of the .sig file, not a URL.
  const sigResponse = await fetchAssetBody(env, picked.sig.id);
  if (!sigResponse.ok) {
    console.error(
      `${LOG_PREFIX} sig fetch failed status=${sigResponse.status}`,
    );
    return new Response("Failed to read signature", { status: 502 });
  }
  const signature = (await sigResponse.text()).trim();

  const manifest = {
    version: latestVersion,
    notes: release.body ?? "",
    pub_date: release.published_at ?? new Date().toISOString(),
    // Download the binary through this Worker so the token stays server-side.
    url: `${origin}/download/${picked.main.id}`,
    signature,
  };

  console.log(
    `${LOG_PREFIX} update offered target=${target} arch=${arch} version=${latestVersion} asset=${picked.main.name}`,
  );

  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleDownload(env: Env, assetId: number): Promise<Response> {
  const assetResponse = await fetchAssetBody(env, assetId);
  if (!assetResponse.ok || !assetResponse.body) {
    console.error(
      `${LOG_PREFIX} asset download failed id=${assetId} status=${assetResponse.status}`,
    );
    return new Response("Failed to download asset", { status: 502 });
  }

  console.log(`${LOG_PREFIX} streaming asset id=${assetId}`);
  return new Response(assetResponse.body, {
    status: 200,
    headers: {
      "Content-Type":
        assetResponse.headers.get("Content-Type") ?? "application/octet-stream",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!env.GH_TOKEN || !env.GITHUB_REPO) {
      console.error(`${LOG_PREFIX} missing GH_TOKEN or GITHUB_REPO env`);
      return new Response("Worker not configured", { status: 500 });
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // /download/:assetId
    if (segments.length === 2 && segments[0] === "download") {
      const assetId = Number.parseInt(segments[1], 10);
      if (!Number.isFinite(assetId)) {
        return new Response("Invalid asset id", { status: 400 });
      }
      return handleDownload(env, assetId);
    }

    // /:target/:arch/:current_version
    if (segments.length === 3) {
      const [target, arch, currentVersion] = segments;
      return handleManifest(env, url.origin, target, arch, currentVersion);
    }

    return new Response("Not found", { status: 404 });
  },
};
