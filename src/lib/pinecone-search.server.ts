import { getRequest } from "@tanstack/react-start/server";

import {
  isInsightField,
  PINECONE_NAMESPACE,
  type PineconeTalkMatch,
} from "@/lib/pinecone-contract";

const QUERY_TIMEOUT_MS = 900;
const CIRCUIT_BREAKER_MS = 30_000;
const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_MATCHES_PER_TALK = 3;

let circuitOpenUntil = 0;
const requestWindows = new Map<string, { startedAt: number; count: number }>();

type PineconeSearchResponse = {
  result?: {
    hits?: Array<{
      _score?: unknown;
      fields?: Record<string, unknown>;
    }>;
  };
};

function allowRequest(): boolean {
  const request = getRequest();
  const address =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
  const now = Date.now();
  const current = requestWindows.get(address);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(address, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function parseMatches(payload: PineconeSearchResponse, catalogContentHash: string): PineconeTalkMatch[] {
  const seen = new Set<string>();
  const matchesPerTalk = new Map<string, number>();
  const matches: PineconeTalkMatch[] = [];
  const hits = [...(payload.result?.hits ?? [])].sort(
    (left, right) =>
      (typeof right._score === "number" ? right._score : -Infinity) -
      (typeof left._score === "number" ? left._score : -Infinity),
  );
  for (const hit of hits) {
    const fields = hit.fields;
    const talkId = fields?.talk_id;
    const field = fields?.field;
    const ordinal = fields?.ordinal;
    const text = fields?.text;
    const contentHash = fields?.catalog_content_hash;
    const score = hit._score;
    if (
      typeof talkId !== "string" ||
      !isInsightField(field) ||
      typeof ordinal !== "number" ||
      typeof text !== "string" ||
      typeof score !== "number" ||
      contentHash !== catalogContentHash ||
      seen.has(`${talkId}:${field}:${ordinal}`) ||
      (matchesPerTalk.get(talkId) ?? 0) >= MAX_MATCHES_PER_TALK
    ) {
      continue;
    }
    seen.add(`${talkId}:${field}:${ordinal}`);
    matchesPerTalk.set(talkId, (matchesPerTalk.get(talkId) ?? 0) + 1);
    matches.push({
      talkId,
      score,
      matchedField: field,
      matchedOrdinal: ordinal,
      matchedText: text,
    });
  }
  return matches;
}

export async function searchPineconeApprovedInsights(query: string) {
  const apiKey = process.env.PINECONE_API_KEY;
  const host = process.env.PINECONE_INDEX_HOST;
  const catalogContentHash = process.env.PINECONE_CATALOG_CONTENT_HASH;
  const enabled = process.env.PINECONE_ENABLED === "true";
  if (
    !enabled ||
    !apiKey ||
    !host ||
    !catalogContentHash ||
    Date.now() < circuitOpenUntil ||
    !allowRequest()
  ) {
    return { available: false as const, matches: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://${host}/records/namespaces/${encodeURIComponent(PINECONE_NAMESPACE)}/search`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-Api-Version": "2025-04",
        },
        body: JSON.stringify({
          // Ask for enough candidates to retain three matching approved
          // bullets for each talk after grouping in the client.
          query: { inputs: { text: query }, top_k: 60 },
          fields: ["talk_id", "field", "ordinal", "text", "catalog_content_hash"],
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Pinecone search failed: ${response.status}`);
    return {
      available: true as const,
      matches: parseMatches((await response.json()) as PineconeSearchResponse, catalogContentHash),
    };
  } catch (error) {
    circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
    console.warn("[pinecone] semantic search unavailable", error instanceof Error ? error.name : "unknown");
    return { available: false as const, matches: [] };
  } finally {
    clearTimeout(timeout);
  }
}
