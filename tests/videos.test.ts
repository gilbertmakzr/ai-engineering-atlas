import { describe, expect, test } from "bun:test";

import {
  TRACKS,
  VIDEOS,
  videoDuration,
  videoTags,
  videoThemes,
  videoYear,
} from "../src/data/videos";
import { LAST_KNOWN_GOOD_CATALOG } from "../src/lib/atlas-catalog";
import { talkInsightForVideo } from "../src/data/talk-insights";
import { appendMetadataOnlyCandidates } from "../scripts/discover-youtube-videos";

describe("verified video catalog", () => {
  test("uses nine unique themes", () => {
    expect(TRACKS).toHaveLength(9);
    expect(new Set(TRACKS.map((track) => track.name)).size).toBe(9);
    expect(new Set(TRACKS.map((track) => track.code)).size).toBe(9);
  });

  test("adds metadata-derived themes and tags without replacing reviewed themes", () => {
    expect(LAST_KNOWN_GOOD_CATALOG).toHaveLength(1095);
    expect(LAST_KNOWN_GOOD_CATALOG.some((video) => videoThemes(video).includes("Knowledge"))).toBe(
      true,
    );
    expect(
      LAST_KNOWN_GOOD_CATALOG.some((video) => videoThemes(video).includes("Developer Workflows")),
    ).toBe(true);
    expect(
      LAST_KNOWN_GOOD_CATALOG.some((video) => videoThemes(video).includes("Models & Training")),
    ).toBe(true);
    expect(LAST_KNOWN_GOOD_CATALOG.every((video) => (video.themes ?? []).length > 0)).toBe(true);
    expect(LAST_KNOWN_GOOD_CATALOG.every((video) => videoTags(video).length > 0)).toBe(true);
  });

  test("contains only complete, unique source records", () => {
    expect(VIDEOS).toHaveLength(15);
    expect(new Set(VIDEOS.map((video) => video.id)).size).toBe(VIDEOS.length);
    expect(new Set(VIDEOS.map((video) => video.code)).size).toBe(VIDEOS.length);
    expect(new Set(VIDEOS.map((video) => video.youtubeId)).size).toBe(VIDEOS.length);
    const knownTracks = new Set(TRACKS.map((track) => track.name));

    for (const video of VIDEOS) {
      expect(video.youtubeId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(video.title.trim()).not.toBe("");
      expect(video.sourceChannel.trim()).not.toBe("");
      expect(video.durationSeconds).toBeGreaterThan(0);
      expect(videoDuration(video)).toMatch(/^(?:\d+:)?\d{1,2}:\d{2}$/);
      expect(knownTracks.has(video.track)).toBe(true);
      expect(Number.isNaN(Date.parse(video.publishedAt))).toBe(false);
      expect(Date.parse(video.publishedAt)).toBeLessThanOrEqual(Date.now());
      expect(videoYear(video)).toBe(new Date(video.publishedAt).getUTCFullYear());
    }
  });

  test("is deterministically sorted by YouTube publication date, latest first", () => {
    expect(VIDEOS).toEqual(
      [...VIDEOS].sort(
        (a, b) =>
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
          a.youtubeId.localeCompare(b.youtubeId),
      ),
    );
    expect(VIDEOS[0]?.youtubeId).toBe("Yk87oUPVaxU");
  });

  test("does not publish the unrelated legacy Zig source", () => {
    expect(VIDEOS.some((video) => video.youtubeId === "kxT8-C1vmd4")).toBe(false);
  });

  test("restores reviewed insights for the Atlas videos", () => {
    const deepSwe = VIDEOS.find((video) => video.youtubeId === "Yk87oUPVaxU");
    const insight = deepSwe && talkInsightForVideo(deepSwe);

    expect(insight?.contentBasis).toBe("transcript_backed");
    expect(insight?.timestampSeconds).toBe(63);
    expect(insight?.claim).toContain("contamination-resistant");
  });

  test("adds discovered uploads as metadata-only records without publishing an insight", () => {
    const result = appendMetadataOnlyCandidates(
      {
        manifest: { recordCount: 1, contentHash: "old" },
        records: [
          {
            id: "youtube-known0000",
            code: "src-known0000",
            title: "Known upload",
            sourceChannel: "AI Engineer",
            track: null,
            tracks: [],
            themes: [],
            publishedAt: "2026-08-01T00:00:00Z",
            durationSeconds: 60,
            youtubeId: "known000000",
            contentStatus: "metadata_only",
            insightReviewStatus: "unmapped",
          },
        ],
      },
      [
        {
          youtubeId: "newvideo000",
          title: "New upload",
          channel: "AI Engineer",
          publishedAt: "2026-08-02T00:00:00Z",
          durationSeconds: 90,
          status: "new",
          provenance: {
            method: "youtube-data-api-v3",
            retrievedAt: "2026-08-02T01:00:00Z",
            uploadsPlaylistId: "UULKPca3kwwd-B59HNr-_lvA",
          },
        },
      ],
      "2026-08-02T01:00:00Z",
    );
    expect(result.additions).toHaveLength(1);
    expect(result.catalog.records[0]?.youtubeId).toBe("newvideo000");
    expect(result.catalog.records[0]?.insightReviewStatus).toBe("unmapped");
    expect(result.catalog.records[0]?.contentStatus).toBe("metadata_only");
    expect(result.catalog.records[0]?.themes).toEqual(["System Design"]);
    expect(result.catalog.records[0]?.themeClassification).toMatchObject({
      source: "metadata_taxonomy",
      basis: "generic_fallback",
    });
    expect(result.catalog.manifest.recordCount).toBe(2);
  });
});
