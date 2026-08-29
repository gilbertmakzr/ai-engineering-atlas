import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpdateInsights } from "../scripts/run-update-insights";

const response = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload });
const env = {
  YOUTUBE_DISCOVERY_ENABLED: "1",
  ATLAS_DISCOVERY_SCHEDULE_ENABLED: "true",
  YOUTUBE_DATA_API_KEY: "test",
  YOUTUBE_DISCOVERY_UPLOADS_PLAYLIST_ID: "UU_test",
  YOUTUBE_DISCOVERY_PACE_MS: "1",
};

const item = (youtubeId: string, publishedAt: string) => ({
  contentDetails: { videoId: youtubeId, videoPublishedAt: publishedAt },
  snippet: { title: `Talk ${youtubeId}`, channelTitle: "AI Engineer" },
});

describe("atlas insights update preflight", () => {
  test("scans paginated uploads until its high-water marker and produces only private candidates", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "atlas-insights-"));
    try {
      await Bun.write(
        join(stateDir, "update-insights-state.json"),
        JSON.stringify({ version: 1, uploadsPlaylistId: "UU_test", highWater: { youtubeId: "old00000000", publishedAt: "2026-08-01T00:00:00Z" }, lastSuccessfulPublicationAt: "2026-08-01T00:00:00Z" }),
      );
      const requests: URL[] = [];
      const result = await runUpdateInsights({
        env,
        stateDir,
        persist: true,
        now: () => new Date("2026-08-10T00:00:00Z"),
        fetchFn: async (input) => {
          const url = new URL(input);
          requests.push(url);
          return response(
            url.searchParams.get("pageToken") === "second"
              ? { items: [item("new00000002", "2026-08-09T00:00:00Z"), item("old00000000", "2026-08-01T00:00:00Z")] }
              : { items: [item("new00000001", "2026-08-10T00:00:00Z")], nextPageToken: "second" },
          );
        },
      });
      expect(result).toMatchObject({ status: "completed", scanned: 3, candidatesAdded: 2, reachedHighWater: true, persisted: true });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.searchParams.get("pageToken")).toBe("second");
      expect(result.browserReview).toMatchObject({ required: true, candidateIds: ["new00000001", "new00000002"] });
      const candidates = JSON.parse(await readFile(join(stateDir, "update-insights-candidates.json"), "utf8"));
      const state = JSON.parse(await readFile(join(stateDir, "update-insights-state.json"), "utf8"));
      expect(candidates.map((candidate: { youtubeId: string }) => candidate.youtubeId)).toEqual(["new00000001", "new00000002"]);
      expect(candidates[0]).toMatchObject({ publicationStatus: "private_candidate", reviewStatus: "browser_transcript_required" });
      expect(state.highWater).toEqual({ youtubeId: "old00000000", publishedAt: "2026-08-01T00:00:00Z" });
      expect(state.lastSuccessfulPublicationAt).toBe("2026-08-01T00:00:00Z");
      expect(state.lastDiscoveredHighWater).toEqual({ youtubeId: "new00000001", publishedAt: "2026-08-10T00:00:00Z" });
      await expect(stat(join(stateDir, "atlas-public-catalog.json"))).rejects.toThrow();
      await expect(stat(join(stateDir, "talk-insights.ts"))).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("is idempotent when no upload is newer than the saved marker", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "atlas-insights-"));
    try {
      await Bun.write(
        join(stateDir, "update-insights-state.json"),
        JSON.stringify({ version: 1, uploadsPlaylistId: "UU_test", highWater: { youtubeId: "new00000001", publishedAt: "2026-08-10T00:00:00Z" }, lastSuccessfulPublicationAt: "2026-08-10T00:00:00Z" }),
      );
      await Bun.write(join(stateDir, "update-insights-candidates.json"), "[]");
      const result = await runUpdateInsights({
        env,
        stateDir,
        persist: true,
        fetchFn: async () => response({ items: [item("new00000001", "2026-08-10T00:00:00Z")] }),
      });
      expect(result).toMatchObject({ status: "completed", candidatesAdded: 0, reachedHighWater: true });
      expect(result.browserReview.required).toBe(false);
      expect(JSON.parse(await readFile(join(stateDir, "update-insights-candidates.json"), "utf8"))).toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("does not write private state unless invoked in CLI persistence mode", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "atlas-insights-"));
    try {
      const result = await runUpdateInsights({
        env,
        stateDir,
        persist: false,
        fetchFn: async () => response({ items: [item("new00000001", "2026-08-10T00:00:00Z")] }),
      });
      expect(result).toMatchObject({ status: "completed", candidatesAdded: 1, persisted: false });
      await expect(stat(join(stateDir, "update-insights-state.json"))).rejects.toThrow();
      await expect(stat(join(stateDir, "update-insights-candidates.json"))).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("leaves no candidate or public artifact behind when the official source is unavailable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "atlas-insights-"));
    try {
      await expect(
        runUpdateInsights({
          env,
          stateDir,
          persist: true,
          fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }),
        }),
      ).rejects.toThrow("YouTube playlistItems request failed with HTTP 503");
      await expect(stat(join(stateDir, "update-insights-state.json"))).rejects.toThrow();
      await expect(stat(join(stateDir, "update-insights-candidates.json"))).rejects.toThrow();
      await expect(stat(join(stateDir, "atlas-public-catalog.json"))).rejects.toThrow();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
