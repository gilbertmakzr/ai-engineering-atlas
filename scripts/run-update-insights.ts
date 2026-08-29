import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MIN_DISCOVERY_PACE_MS } from "./discover-video-sources";

export const UPDATE_INSIGHTS_PAGE_SIZE = 50;

export type InsightHighWater = { youtubeId: string; publishedAt: string };

export type UpdateInsightsState = {
  version: 1;
  uploadsPlaylistId: string;
  /** Advanced only by the reviewed-publication step, never this preflight. */
  highWater: InsightHighWater | null;
  /** Written only by the reviewed-publication step, never this preflight. */
  lastSuccessfulPublicationAt: string | null;
  lastDiscoveryAt?: string;
  lastDiscoveredHighWater?: InsightHighWater | null;
};

export type InsightReviewCandidate = {
  youtubeId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  sourceUrl: string;
  discoveredAt: string;
  source: "youtube_data_api";
  reviewStatus: "browser_transcript_required";
  publicationStatus: "private_candidate";
  nextAction: "open_video_one_at_a_time_and_capture_transcript";
};

export type UpdateInsightsResult = {
  status: "disabled" | "completed";
  scanned: number;
  candidatesAdded: number;
  reachedHighWater: boolean;
  persisted: boolean;
  browserReview: {
    required: boolean;
    candidateIds: string[];
    instruction: string;
  };
};

type PlaylistItem = {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
};
type PlaylistPage = { items?: PlaylistItem[]; nextPageToken?: string };
type FetchResponse = Pick<Response, "ok" | "status" | "json">;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>;

export type UpdateInsightsOptions = {
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
  stateDir?: string;
  now?: () => Date;
  /** File writes are reserved for the operator CLI. Tests should inject false. */
  persist?: boolean;
};

function requireValue(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required for an enabled insights update.`);
  return value.trim();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function sleep(milliseconds: number) {
  await new Promise((done) => setTimeout(done, milliseconds));
}

async function playlistPage(
  uploadsPlaylistId: string,
  apiKey: string,
  pageToken: string | undefined,
  fetchFn: FetchLike,
): Promise<PlaylistPage> {
  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet,contentDetails");
  url.searchParams.set("playlistId", uploadsPlaylistId);
  url.searchParams.set("maxResults", String(UPDATE_INSIGHTS_PAGE_SIZE));
  url.searchParams.set("key", apiKey);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!response.ok)
    throw new Error(`YouTube playlistItems request failed with HTTP ${response.status}.`);
  return (await response.json()) as PlaylistPage;
}

function candidateFrom(item: PlaylistItem, discoveredAt: string): InsightReviewCandidate | null {
  const youtubeId = item.contentDetails?.videoId;
  const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
  const title = item.snippet?.title;
  const channelTitle = item.snippet?.channelTitle;
  if (!youtubeId || !publishedAt || !title || !channelTitle || Number.isNaN(Date.parse(publishedAt)))
    return null;
  return {
    youtubeId,
    title,
    channelTitle,
    publishedAt,
    sourceUrl: `https://www.youtube.com/watch?v=${youtubeId}`,
    discoveredAt,
    source: "youtube_data_api",
    reviewStatus: "browser_transcript_required",
    publicationStatus: "private_candidate",
    nextAction: "open_video_one_at_a_time_and_capture_transcript",
  };
}

export function isNewerThanHighWater(
  candidate: Pick<InsightReviewCandidate, "youtubeId" | "publishedAt">,
  highWater: InsightHighWater | null,
) {
  if (!highWater) return true;
  const candidateTime = Date.parse(candidate.publishedAt);
  const highWaterTime = Date.parse(highWater.publishedAt);
  return (
    candidateTime > highWaterTime ||
    (candidateTime === highWaterTime && candidate.youtubeId !== highWater.youtubeId)
  );
}

export function mergePrivateCandidates(
  existing: InsightReviewCandidate[],
  discovered: InsightReviewCandidate[],
) {
  const existingIds = new Set(existing.map((candidate) => candidate.youtubeId));
  const additions = discovered.filter((candidate) => !existingIds.has(candidate.youtubeId));
  return { additions, candidates: [...existing, ...additions] };
}

export async function runUpdateInsights(
  options: UpdateInsightsOptions = {},
): Promise<UpdateInsightsResult> {
  const env = options.env ?? process.env;
  if (env.YOUTUBE_DISCOVERY_ENABLED !== "1" || env.ATLAS_DISCOVERY_SCHEDULE_ENABLED !== "true") {
    return {
      status: "disabled",
      scanned: 0,
      candidatesAdded: 0,
      reachedHighWater: false,
      persisted: false,
      browserReview: { required: false, candidateIds: [], instruction: "" },
    };
  }

  const apiKey = requireValue(env.YOUTUBE_DATA_API_KEY, "YOUTUBE_DATA_API_KEY");
  const uploadsPlaylistId = requireValue(
    env.YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID,
    "YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID",
  );
  const stateDir = resolve(options.stateDir ?? env.ATLAS_STATE_DIR ?? "var/atlas-state");
  const statePath = resolve(stateDir, "update-insights-state.json");
  const candidatesPath = resolve(stateDir, "update-insights-candidates.json");
  const persist = options.persist ?? import.meta.main;
  const now = options.now?.() ?? new Date();
  const discoveredAt = now.toISOString();
  const previousState = await readJson<UpdateInsightsState | null>(statePath, null);
  const previousCandidates = await readJson<InsightReviewCandidate[]>(candidatesPath, []);
  const highWater =
    previousState?.uploadsPlaylistId === uploadsPlaylistId ? previousState.highWater : null;
  const fetchFn = options.fetchFn ?? fetch;
  const paceMs = Math.max(
    MIN_DISCOVERY_PACE_MS,
    Number(env.YOUTUBE_DISCOVERY_PACE_MS) || MIN_DISCOVERY_PACE_MS,
  );

  let pageToken: string | undefined;
  let scanned = 0;
  let reachedHighWater = false;
  const found: InsightReviewCandidate[] = [];
  let newest: InsightReviewCandidate | null = null;

  // The uploads playlist is newest-first. Stop only after the saved marker is
  // visible, so every intervening page is checked instead of trusting a fixed cap.
  do {
    const page = await playlistPage(uploadsPlaylistId, apiKey, pageToken, fetchFn);
    const pageCandidates = (page.items ?? [])
      .map((item) => candidateFrom(item, discoveredAt))
      .filter((candidate): candidate is InsightReviewCandidate => candidate !== null);
    scanned += pageCandidates.length;
    if (!newest && pageCandidates.length > 0) newest = pageCandidates[0];

    for (const candidate of pageCandidates) {
      if (highWater && candidate.youtubeId === highWater.youtubeId) {
        reachedHighWater = true;
        break;
      }
      if (isNewerThanHighWater(candidate, highWater)) found.push(candidate);
    }
    if (reachedHighWater || !page.nextPageToken) break;
    pageToken = page.nextPageToken;
    await sleep(paceMs);
  } while (pageToken);

  const { additions, candidates } = mergePrivateCandidates(previousCandidates, found);
  const nextState: UpdateInsightsState = {
    version: 1,
    uploadsPlaylistId,
    // Do not advance this marker from preflight. Publication advances it only
    // after browser transcript review and approved public integration, so an
    // interrupted or rejected batch remains discoverable on the next run.
    highWater,
    lastSuccessfulPublicationAt: previousState?.lastSuccessfulPublicationAt ?? null,
    lastDiscoveryAt: discoveredAt,
    lastDiscoveredHighWater: newest
      ? { youtubeId: newest.youtubeId, publishedAt: newest.publishedAt }
      : null,
  };
  if (persist) {
    // State is intentionally ignored. This workflow cannot write any public
    // catalog, projection or insight file: browser review and human approval
    // remain separate release steps.
    await Promise.all([
      writeJsonAtomically(candidatesPath, candidates),
      writeJsonAtomically(statePath, nextState),
    ]);
  }

  return {
    status: "completed",
    scanned,
    candidatesAdded: additions.length,
    reachedHighWater,
    persisted: persist,
    browserReview: {
      required: additions.length > 0,
      candidateIds: additions.map((candidate) => candidate.youtubeId),
      instruction:
        "Review each private candidate in Browser Use one at a time, capture an available transcript, close its tab, then draft taxonomy and timestamped insights for human approval. Do not publish directly from this run.",
    },
  };
}

if (import.meta.main) console.log(JSON.stringify(await runUpdateInsights(), null, 2));
