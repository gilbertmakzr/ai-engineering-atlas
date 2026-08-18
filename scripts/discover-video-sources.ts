import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export const YOUTUBE_DISCOVERY_BATCH_SIZE = 10;
export const MIN_DISCOVERY_PACE_MS = 250;

export type DiscoveryState = {
  version: 1;
  uploadsPlaylistId: string;
  highWater: { youtubeId: string; publishedAt: string } | null;
  updatedAt: string;
  lastRun: { id: string; responseHash: string };
};

export type DiscoveryCandidate = {
  youtubeId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  sourceUrl: string;
  discoveredAt: string;
  source: "youtube_data_api";
  reviewStatus: "review_required";
  acquisitionStatus: "not_requested";
  runId: string;
  responseHash: string;
};

export type DiscoveryResult = {
  status: "disabled" | "completed";
  uploadsPlaylistId?: string;
  fetched: number;
  candidatesAdded: number;
};

type PlaylistItem = {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
};
type FetchResponse = Pick<Response, "ok" | "status" | "json">;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>;

function requireValue(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required for the enabled daily discovery run.`);
  return value.trim();
}

function localKeychainApiKey() {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        "AI Engineer Atlas YouTube Discovery",
        "-a",
        "youtube-data-api-key",
        "-w",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
}

async function sleep(milliseconds: number) {
  await new Promise((done) => setTimeout(done, milliseconds));
}

async function apiJson<T>(url: URL, fetchFn: FetchLike, paceMs: number): Promise<T> {
  let failure: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchFn(url, { headers: { accept: "application/json" } });
      if (!response.ok)
        throw new Error(`YouTube Data API request failed with HTTP ${response.status}.`);
      return (await response.json()) as T;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2) await sleep(paceMs);
    }
  }
  throw failure;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAfter(candidate: DiscoveryCandidate, highWater: DiscoveryState["highWater"]) {
  if (!highWater) return true;
  const time = Date.parse(candidate.publishedAt);
  const highWaterTime = Date.parse(highWater.publishedAt);
  return (
    time > highWaterTime || (time === highWaterTime && candidate.youtubeId !== highWater.youtubeId)
  );
}

export async function runYouTubeMetadataDiscovery(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchFn?: FetchLike;
    stateDir?: string;
    now?: () => Date;
  } = {},
): Promise<DiscoveryResult> {
  const env = options.env ?? process.env;
  // Daily automation needs two affirmative controls: discovery and an operator-authorized schedule.
  if (env.YOUTUBE_DISCOVERY_ENABLED !== "1" || env.ATLAS_DISCOVERY_SCHEDULE_ENABLED !== "true") {
    return { status: "disabled", fetched: 0, candidatesAdded: 0 };
  }
  const apiKey = requireValue(
    env.YOUTUBE_DATA_API_KEY ?? (env === process.env ? localKeychainApiKey() : undefined),
    "YOUTUBE_DATA_API_KEY",
  );
  const uploadsPlaylistId = requireValue(
    env.YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID,
    "YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID",
  );
  const stateDir = resolve(options.stateDir ?? env.ATLAS_STATE_DIR ?? "var/atlas-state");
  const paceMs = Math.max(
    MIN_DISCOVERY_PACE_MS,
    Number(env.YOUTUBE_DISCOVERY_PACE_MS) || MIN_DISCOVERY_PACE_MS,
  );
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", uploadsPlaylistId);
  url.searchParams.set("maxResults", String(YOUTUBE_DISCOVERY_BATCH_SIZE));
  url.searchParams.set("key", apiKey);
  const payload = await apiJson<{ items?: PlaylistItem[] }>(url, options.fetchFn ?? fetch, paceMs);
  const responseHash = await sha256(JSON.stringify(payload));
  const now = options.now?.() ?? new Date();
  const discoveredAt = now.toISOString();
  const runId = `youtube-metadata-${discoveredAt.replace(/[:.]/g, "-")}`;
  const statePath = resolve(stateDir, "youtube-discovery-state.json");
  const candidatesPath = resolve(stateDir, "youtube-discovery-candidates.json");
  const state = await readJson<DiscoveryState | null>(statePath, null);
  const candidates = await readJson<DiscoveryCandidate[]>(candidatesPath, []);
  const batch = (payload.items ?? []).flatMap((item): DiscoveryCandidate[] => {
    const youtubeId = item.contentDetails?.videoId;
    const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
    const title = item.snippet?.title;
    const channelTitle = item.snippet?.channelTitle;
    if (
      !youtubeId ||
      !publishedAt ||
      !title ||
      !channelTitle ||
      Number.isNaN(Date.parse(publishedAt))
    )
      return [];
    return [
      {
        youtubeId,
        title,
        channelTitle,
        publishedAt,
        sourceUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
        discoveredAt,
        source: "youtube_data_api",
        reviewStatus: "review_required",
        acquisitionStatus: "not_requested",
        runId,
        responseHash,
      },
    ];
  });
  const previousHighWater = state?.uploadsPlaylistId === uploadsPlaylistId ? state.highWater : null;
  const existingIds = new Set(candidates.map((candidate) => candidate.youtubeId));
  const additions = batch.filter(
    (candidate) => !existingIds.has(candidate.youtubeId) && isAfter(candidate, previousHighWater),
  );
  const newest = [...batch].sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
      right.youtubeId.localeCompare(left.youtubeId),
  )[0];
  const nextState: DiscoveryState = {
    version: 1,
    uploadsPlaylistId,
    highWater: newest
      ? { youtubeId: newest.youtubeId, publishedAt: newest.publishedAt }
      : previousHighWater,
    updatedAt: discoveredAt,
    lastRun: { id: runId, responseHash },
  };
  // These private files are deliberately never imported by public projection generation.
  await writeJsonAtomic(candidatesPath, [...candidates, ...additions]);
  await writeJsonAtomic(statePath, nextState);
  return {
    status: "completed",
    uploadsPlaylistId,
    fetched: batch.length,
    candidatesAdded: additions.length,
  };
}

if (import.meta.main) console.log(JSON.stringify(await runYouTubeMetadataDiscovery()));
