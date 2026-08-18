import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { inferredThemesFromTitle } from "../src/data/catalog-taxonomy";
import { MIN_DISCOVERY_PACE_MS } from "./discover-video-sources";

export const YOUTUBE_RECONCILIATION_PAGE_SIZE = 50;
export const DEFAULT_DAILY_RECONCILIATION_PAGES = 1;

type CatalogRecord = {
  id: string;
  code: string;
  title: string;
  sourceChannel: string;
  track: null;
  tracks: string[];
  themes: string[];
  themeClassification: {
    source: "metadata_taxonomy";
    basis: "title_rules" | "generic_fallback";
    classifiedAt: string;
  };
  publishedAt: string;
  durationSeconds: number;
  youtubeId: string;
  contentStatus: "metadata_only";
  insightReviewStatus: "unmapped";
};

export type CatalogDocument = {
  manifest: Record<string, unknown> & { recordCount: number; contentHash: string };
  records: CatalogRecord[];
};

export type Candidate = {
  youtubeId: string;
  title: string;
  channel: string;
  publishedAt: string;
  durationSeconds: number;
  status: "new";
  provenance: {
    method: "youtube-data-api-v3";
    retrievedAt: string;
    uploadsPlaylistId: string;
  };
};

type ReconciliationState = {
  version: 1;
  uploadsPlaylistId?: string;
  nextPageToken?: string;
  completedAt?: string;
  lastSuccessfulRunAt?: string;
};

export type ReconciliationResult = {
  status: "disabled" | "completed";
  scanned: number;
  candidatesAdded: number;
  published: number;
  fullCoverageConfirmed: boolean;
};

type PlaylistItem = { contentDetails?: { videoId?: string } };
type VideoResource = {
  id?: string;
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
  contentDetails?: { duration?: string };
};
type FetchResponse = Pick<Response, "ok" | "status" | "json">;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<FetchResponse>;

function requireValue(value: string | undefined, name: string) {
  if (!value?.trim()) throw new Error(`${name} is required for the enabled reconciliation run.`);
  return value.trim();
}

function durationSeconds(isoDuration: string | undefined) {
  const match = isoDuration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function safeCode(youtubeId: string) {
  return `src-${youtubeId.toLowerCase()}`;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const char of Buffer.from(value, "utf8")) hash = ((hash ^ BigInt(char)) * prime) & mask;
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

async function sleep(milliseconds: number) {
  await new Promise((done) => setTimeout(done, milliseconds));
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
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
}

async function youtubeGet<T>(resource: string, params: Record<string, string>, fetchFn: FetchLike) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!response.ok)
    throw new Error(`YouTube ${resource} request failed with HTTP ${response.status}.`);
  return (await response.json()) as T;
}

export function asCatalogRecord(candidate: Candidate): CatalogRecord {
  const inferredThemes = inferredThemesFromTitle(candidate.title);
  const themes = inferredThemes.length ? inferredThemes : ["System Design"];
  return {
    id: `youtube-${candidate.youtubeId}`,
    code: safeCode(candidate.youtubeId),
    title: candidate.title,
    sourceChannel: candidate.channel,
    track: null,
    tracks: themes,
    themes,
    themeClassification: {
      source: "metadata_taxonomy",
      basis: inferredThemes.length ? "title_rules" : "generic_fallback",
      classifiedAt: candidate.provenance.retrievedAt,
    },
    publishedAt: candidate.publishedAt,
    durationSeconds: candidate.durationSeconds,
    youtubeId: candidate.youtubeId,
    contentStatus: "metadata_only",
    insightReviewStatus: "unmapped",
  };
}

export function appendMetadataOnlyCandidates(
  catalog: CatalogDocument,
  candidates: Candidate[],
  generatedAt: string,
) {
  const knownIds = new Set(catalog.records.map((record) => record.youtubeId));
  const additions = candidates
    .filter((candidate) => !knownIds.has(candidate.youtubeId))
    .map(asCatalogRecord);
  if (additions.length === 0) return { catalog, additions };

  const records = [...catalog.records, ...additions].sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
      left.youtubeId.localeCompare(right.youtubeId),
  );
  return {
    additions,
    catalog: {
      ...catalog,
      manifest: {
        ...catalog.manifest,
        generatedAt,
        sourceCatalogVerifiedAt: generatedAt,
        recordCount: records.length,
        contentHash: fnv1a64(JSON.stringify(records)),
      },
      records,
    },
  };
}

export async function runYouTubeCatalogReconciliation(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchFn?: FetchLike;
    stateDir?: string;
    catalogPath?: string;
    now?: () => Date;
  } = {},
): Promise<ReconciliationResult> {
  const env = options.env ?? process.env;
  if (env.YOUTUBE_DISCOVERY_ENABLED !== "1" || env.ATLAS_DISCOVERY_SCHEDULE_ENABLED !== "true")
    return {
      status: "disabled",
      scanned: 0,
      candidatesAdded: 0,
      published: 0,
      fullCoverageConfirmed: false,
    };

  const apiKey = requireValue(env.YOUTUBE_DATA_API_KEY, "YOUTUBE_DATA_API_KEY");
  const uploadsPlaylistId = requireValue(
    env.YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID,
    "YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID",
  );
  const stateDir = resolve(options.stateDir ?? env.ATLAS_STATE_DIR ?? "var/atlas-state");
  const catalogPath = resolve(options.catalogPath ?? "src/data/atlas-public-catalog.json");
  const statePath = resolve(stateDir, "youtube-reconciliation-state.json");
  const candidatesPath = resolve(stateDir, "youtube-reconciliation-candidates.json");
  const state = await readJson<ReconciliationState>(statePath, { version: 1 });
  const catalog = await readJson<CatalogDocument>(catalogPath, {
    manifest: { recordCount: 0, contentHash: "" },
    records: [],
  });
  const fullRun = env.YOUTUBE_DISCOVERY_RECONCILE_FULL === "true";
  const pageBudget = fullRun
    ? Number.POSITIVE_INFINITY
    : Math.max(
        1,
        Math.min(
          10,
          Number(env.YOUTUBE_DAILY_RECONCILIATION_PAGES) || DEFAULT_DAILY_RECONCILIATION_PAGES,
        ),
      );
  const paceMs = Math.max(
    MIN_DISCOVERY_PACE_MS,
    Number(env.YOUTUBE_DISCOVERY_PACE_MS) || MIN_DISCOVERY_PACE_MS,
  );
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now?.() ?? new Date();
  const retrievedAt = now.toISOString();
  const knownIds = new Set(catalog.records.map((record) => record.youtubeId));
  const unknownIds: string[] = [];
  let scanned = 0;
  let pageToken = state.uploadsPlaylistId === uploadsPlaylistId ? state.nextPageToken : undefined;
  let exhausted = false;

  for (let page = 0; page < pageBudget; page += 1) {
    const payload = await youtubeGet<{ items?: PlaylistItem[]; nextPageToken?: string }>(
      "playlistItems",
      {
        key: apiKey,
        part: "contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: String(YOUTUBE_RECONCILIATION_PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      },
      fetchFn,
    );
    const ids = (payload.items ?? []).flatMap((item) =>
      item.contentDetails?.videoId ? [item.contentDetails.videoId] : [],
    );
    scanned += ids.length;
    unknownIds.push(...ids.filter((id) => !knownIds.has(id)));
    pageToken = payload.nextPageToken;
    if (!pageToken) {
      exhausted = true;
      break;
    }
    await sleep(paceMs);
  }

  const candidates: Candidate[] = [];
  for (let start = 0; start < unknownIds.length; start += YOUTUBE_RECONCILIATION_PAGE_SIZE) {
    const ids = unknownIds.slice(start, start + YOUTUBE_RECONCILIATION_PAGE_SIZE);
    const payload = await youtubeGet<{ items?: VideoResource[] }>(
      "videos",
      { key: apiKey, part: "snippet,contentDetails", id: ids.join(",") },
      fetchFn,
    );
    for (const video of payload.items ?? []) {
      const duration = durationSeconds(video.contentDetails?.duration);
      if (
        !video.id ||
        !video.snippet?.title ||
        !video.snippet.channelTitle ||
        !video.snippet.publishedAt ||
        duration === null
      )
        continue;
      candidates.push({
        youtubeId: video.id,
        title: video.snippet.title,
        channel: video.snippet.channelTitle,
        publishedAt: video.snippet.publishedAt,
        durationSeconds: duration,
        status: "new",
        provenance: { method: "youtube-data-api-v3", retrievedAt, uploadsPlaylistId },
      });
    }
    if (start + YOUTUBE_RECONCILIATION_PAGE_SIZE < unknownIds.length) await sleep(paceMs);
  }

  const pending = await readJson<Candidate[]>(candidatesPath, []);
  const pendingIds = new Set(pending.map((candidate) => candidate.youtubeId));
  const newCandidates = candidates.filter((candidate) => !pendingIds.has(candidate.youtubeId));
  const projection =
    env.ATLAS_METADATA_AUTO_PUBLISH_ENABLED === "true"
      ? appendMetadataOnlyCandidates(catalog, candidates, retrievedAt)
      : { catalog, additions: [] as CatalogRecord[] };
  await Promise.all([
    writeJsonAtomically(candidatesPath, [...pending, ...newCandidates]),
    writeJsonAtomically(statePath, {
      version: 1,
      uploadsPlaylistId,
      nextPageToken: exhausted ? undefined : pageToken,
      completedAt: exhausted ? retrievedAt : state.completedAt,
      lastSuccessfulRunAt: retrievedAt,
    } satisfies ReconciliationState),
    ...(projection.additions.length > 0
      ? [writeJsonAtomically(catalogPath, projection.catalog)]
      : []),
  ]);
  return {
    status: "completed",
    scanned,
    candidatesAdded: newCandidates.length,
    published: projection.additions.length,
    fullCoverageConfirmed: exhausted,
  };
}

if (import.meta.main) console.log(JSON.stringify(await runYouTubeCatalogReconciliation()));
