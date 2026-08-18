import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Clock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TRACKS,
  videoDuration,
  videoPublishedDate,
  videoTracks,
  videoThemes,
  videoTags,
  videoYear,
  type Track,
  type Video,
} from "@/data/videos";
import { atlasTagLabel, atlasTagTheme } from "@/data/catalog-taxonomy";
import { AtlasNavigation } from "@/components/atlas-navigation";
import { TRACK_EXAMPLES, TRACK_SUMMARIES } from "@/data/summaries";
import { loadAtlasCatalog } from "@/lib/atlas-catalog-client";
import { loadTalkInsight } from "@/lib/talk-insights-client";
import type { IllustrativeExample, TalkInsight } from "@/data/talk-insights";
import type { CatalogVideo } from "@/lib/atlas-catalog";
import { trackEvent, logClientError, perfMark } from "@/lib/analytics";
import {
  consolidateTimestampGroups,
  hasTimestampReference,
  parseNumberedInsightText,
  splitInsightSentences,
} from "@/lib/insight-formatting";
import type { PineconeTalkMatch } from "@/lib/pinecone-contract";

const SCROLL_KEY = "atlas:scroll-v1";
const PAGE_SIZE = 12;

function placeholderThumb(v: Video, token: string) {
  // Deterministic SVG placeholder when the YouTube thumbnail is unavailable.
  // Uses the track color and encodes channel initials + video code so the
  // card still communicates identity without a fetched image.
  const initials = v.sourceChannel
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const color =
    getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim() || "#1a1a2a";
  const svg = `<?xml version='1.0' encoding='UTF-8'?>
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360' role='img'>
  <defs>
    <linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0%' stop-color='${color}' stop-opacity='0.95'/>
      <stop offset='100%' stop-color='#0f0f14' stop-opacity='0.95'/>
    </linearGradient>
    <pattern id='dots' width='16' height='16' patternUnits='userSpaceOnUse'>
      <circle cx='1' cy='1' r='1' fill='#ffffff' fill-opacity='0.08'/>
    </pattern>
  </defs>
  <rect width='640' height='360' fill='url(#g)'/>
  <rect width='640' height='360' fill='url(#dots)'/>
  <text x='40' y='90' font-family='ui-monospace, monospace' font-size='16' fill='#ffffff' fill-opacity='0.7' letter-spacing='4'>${v.code.toUpperCase()} · ${videoYear(v)}</text>
  <text x='40' y='210' font-family='ui-serif, Georgia, serif' font-size='120' font-weight='700' fill='#ffffff'>${initials || "AI"}</text>
  <text x='40' y='300' font-family='ui-sans-serif, system-ui' font-size='20' fill='#ffffff' fill-opacity='0.85'>${escapeXml(v.sourceChannel)}</text>
  <text x='40' y='328' font-family='ui-sans-serif, system-ui' font-size='14' fill='#ffffff' fill-opacity='0.6'>${escapeXml(v.track ?? "Unclassified")}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string) {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
  );
}

function Thumbnail({ video, token, eager }: { video: Video; token: string; eager: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src = errored
    ? placeholderThumb(video, token)
    : `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`;
  return (
    <>
      {!loaded && (
        <div
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted via-muted/60 to-muted"
          aria-hidden
        />
      )}
      <img
        src={src}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => {
          if (!errored) {
            logClientError("thumbnail_failed", {
              videoId: video.youtubeId,
              code: video.code,
              sourceChannel: video.sourceChannel,
            });
            setErrored(true);
            setLoaded(true);
          }
        }}
        className={
          "h-full w-full object-cover transition-all duration-500 motion-safe:group-hover:scale-[1.03] motion-reduce:transition-none " +
          (loaded ? "opacity-100" : "opacity-0")
        }
      />
    </>
  );
}

function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-ink/15 bg-card shadow-[0_10px_30px_-15px_rgba(20,20,40,0.35)]">
      <div className="aspect-video animate-pulse bg-gradient-to-br from-muted via-muted/60 to-muted" />
      <div className="flex flex-col gap-3 p-4">
        <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-5 w-5/6 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-3 w-full animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

const LEGACY_TRACK_SUMMARIES: Record<
  Exclude<Track, "Knowledge" | "Developer Workflows" | "Models & Training">,
  { claim: string; implication: string; whenToUse: string; caveat: string }
> = {
  "System Design": {
    claim:
      "The interesting design decision in an LLM system is not the model — it's the boundary between the agent's execution loop and the domain-specific expertise it draws on. Keep the loop small, generic, and inspectable; move the knowledge, tools, and policies into versioned skills you can review and swap independently. Systems that survive teams and model upgrades treat orchestration as infrastructure and expertise as content.",
    implication:
      "Treat every capability (a tool call, a retrieval strategy, a domain-specific playbook) as a first-class artifact with a version, an owner, an eval, and a rollback story. The runtime becomes thin — a scheduler for skills — and each skill can evolve, be A/B tested, or be retired without touching the surrounding system. This also makes on-call diagnosable: a regression maps to a specific skill version, not a monolithic prompt no one dares to change.",
    whenToUse:
      "Reach for this pattern once a single agent starts serving multiple domains, once more than one team contributes to prompts, or once you find yourself branching one giant system prompt on user attributes. It is also the right shape when compliance or safety reviewers need to sign off on capabilities in isolation rather than reading a 12-page monolithic prompt.",
    caveat:
      "Every abstraction has a coordination cost. Splitting too early creates ceremony without payoff — three skills owned by one engineer is just three files. Start monolithic, extract a skill only when a real seam has appeared (a second consumer, a distinct owner, a divergent eval), and be honest about which skills are load-bearing versus decorative.",
  },
  "Data & Eval": {
    claim:
      "Evaluation is a product surface, not a notebook artifact. The talks that hold up in production frame evals the way backend engineers frame tests: they are the thing that lets you change the system safely. If you cannot measure a regression, you cannot ship an improvement — you can only ship vibes and hope the next user is generous.",
    implication:
      "Treat eval datasets as living code. Version them, review them in PRs, grow them from real production traces, and gate every deploy on a set of behaviors that matter to the business. Combine cheap heuristic checks with human-labeled slices and LLM-as-judge only where it has itself been calibrated against humans. The output is not a single accuracy number; it's a dashboard of behaviors you refuse to regress.",
    whenToUse:
      "Any time a change to a prompt, model, retrieval pipeline, or tool schema can silently degrade user-facing quality. That is essentially every change in an LLM system. Adopt evals before scaling traffic, before swapping models, and before letting more than one person edit the prompt — retrofitting evals under production pressure is where teams stall.",
    caveat:
      "Bad evals are worse than no evals: they encode false confidence. A benchmark that looks green while users churn is telling you your dataset is off, not that your system is good. Invest in dataset curation, labeled failure modes, and honest sampling from production before chasing more sophisticated scoring — an LLM judge on top of a shallow dataset just launders bad taste into a number.",
  },
  Reliability: {
    claim:
      "Structure is cheaper than parsing. The moment an LLM output feeds another program, free text becomes a liability — you are one unlucky sampling away from a runtime exception, a corrupted row, or a silently wrong tool call. Force the model into schemas the rest of the system can depend on, and reliability stops being a prayer and starts being a property.",
    implication:
      "Wrap every LLM call in typed contracts, validators, and bounded retries. Use structured-output APIs where they exist, function/tool schemas where they don't, and a small validation + repair loop for the edges. Downstream code should never negotiate with the model — it should consume a validated object or fail closed with a legible error you can trace.",
    whenToUse:
      "Any path where an LLM decision drives a tool call, a database write, a workflow branch, or a UI component with fixed props. Also whenever you find yourself writing regex to extract fields out of a completion — that is the signal to move the constraint upstream into the model call itself.",
    caveat:
      "Over-constraining schemas can strangle useful reasoning. If every field is required and every enum is closed, the model will fabricate to satisfy the shape instead of surfacing uncertainty. Leave room for 'unknown', 'needs_human', and short free-text rationale fields — reliability is about predictable failure modes, not fake certainty.",
  },
  Observability: {
    claim:
      "You cannot improve what you cannot see, and in LLM systems 'see' means more than latency and error rate. Prompts, tool spans, retrieved chunks, model versions, user feedback, and eval scores all belong in the same pane as your existing SRE signals. Observability is the difference between debugging a regression in an afternoon and rewriting the prompt on a hunch at 2am.",
    implication:
      "Instrument every LLM call with the inputs, outputs, tool spans, model version, and user or automated feedback tied back to a trace ID. Feed those traces into your eval sets, your error triage, and your product analytics. When quality drops, you should be able to filter to the exact 200 traces that changed and diff them against last week.",
    whenToUse:
      "The moment a system leaves one developer's laptop and starts serving real requests — even internal traffic counts. Retrofitting tracing after an incident is expensive and lossy; the cheapest time to add it is before you need it, and the second-cheapest is right now.",
    caveat:
      "Logging raw prompts and completions creates a PII and IP surface that legal will care about eventually. Bake in redaction, per-tenant retention limits, and access controls from day one. An observability system that leaks user data is a bigger incident than the bug it was meant to help you find.",
  },
  "Safety & Control": {
    claim:
      "Guardrails are a system property, not a model property. No single prompt, classifier, or fine-tune is going to make an agent safe on its own — safety comes from layered checks at the input, the output, and the action boundary, plus the humility to fail closed when any layer is uncertain. Treat it the way you treat security: defense in depth, assumed breach.",
    implication:
      "Combine policy checks, refusal audits, red-team suites, and human-in-the-loop escalation with the same rigor you apply to authz and secrets. Every high-impact action (payments, emails, deletions, external calls) should have an explicit allowlist, a rate limit, and a reversible path. Measure not only what you blocked but what you should have blocked and didn't.",
    whenToUse:
      "Any deployment where the model can take actions with real-world consequences, quote external sources users will trust, or reach users you don't personally know. That includes internal tools once they touch production data — 'it's just for the team' is where most incidents start.",
    caveat:
      "Over-cautious guardrails erode trust and usefulness faster than most teams admit. A model that refuses half of legitimate requests trains users to route around it, which is worse than a permissive system with good audit trails. Measure false positives and user friction alongside missed harms, and be willing to loosen when the data supports it.",
  },
  Deployment: {
    claim:
      "Shipping an LLM feature is a latency, cost, and quality tradeoff — pick two explicitly and design for the third. Every architectural choice, from model selection to caching to prompt length, is a move along that triangle. Teams that try to optimize all three at once end up with a system that is mediocre at all three and expensive to reason about.",
    implication:
      "Route requests across models by task, cache aggressively at the semantic layer, and treat model choice as a runtime concern behind a stable interface. Instrument p50/p95 latency and cost-per-request alongside quality metrics, and set explicit SLOs so tradeoffs are made deliberately rather than accidentally when the bill arrives.",
    whenToUse:
      "Once a prototype needs to serve real traffic under a budget and an SLA rather than a demo audience. The transition from 'it works in the notebook' to 'it works at 100 QPS at a price the business can absorb' is where most projects discover they built for the wrong point on the triangle.",
    caveat:
      "Premature multi-model routing hides bugs and makes evals harder — a regression in one model in one route can look like noise. Prove quality on a single model with clean traces first, then add routing as an escape hatch with its own tests. Complexity in the serving path should be earned, not assumed.",
  },
};

const LEGACY_TRACK_EXAMPLES: Record<
  Exclude<Track, "Knowledge" | "Developer Workflows" | "Models & Training">,
  IllustrativeExample
> = {
  "System Design": {
    situation:
      "An incident-response agent has accumulated one large prompt that mixes orchestration, tool instructions, and team policy.",
    application:
      "Keep the execution loop stable, then extract the incident playbook into a versioned skill with its own owner and eval set.",
    observableOutcome:
      "A regression can be traced to one skill version and rolled back without replacing the surrounding runtime.",
  },
  "Data & Eval": {
    situation:
      "A prompt revision looks better in a demo, but the team cannot tell whether it regresses difficult production cases.",
    application:
      "Build a reviewed golden set from real failure modes and make it a deployment gate alongside deterministic checks.",
    observableOutcome:
      "The release shows which behaviors improved, which regressed, and which slices still need human review.",
  },
  Reliability: {
    situation:
      "A support workflow parses free-text model output before issuing refunds, and malformed fields occasionally reach downstream code.",
    application:
      "Move the contract upstream into a typed schema, validate every response, and fail closed after bounded repair attempts.",
    observableOutcome:
      "Schema failures become measurable events instead of silent data corruption or unpredictable tool calls.",
  },
  Observability: {
    situation:
      "An agent fails intermittently, but logs contain only the user prompt and final answer.",
    application:
      "Capture the model version, retrieved context, decisions, tool spans, and state transitions under one trace identifier.",
    observableOutcome:
      "Engineers can replay the failing path and isolate the changed input, tool response, or model behavior.",
  },
  "Safety & Control": {
    situation:
      "An agent can prepare and execute a high-value transfer through the same unrestricted tool path.",
    application:
      "Separate proposal from execution and gate the action with identity, policy, amount, and explicit approval checks.",
    observableOutcome:
      "The useful proposal is preserved while consequential execution remains reviewable, reversible, and auditable.",
  },
  Deployment: {
    situation:
      "A production assistant meets quality targets but misses its latency and cost budgets during peak traffic.",
    application:
      "Set explicit service-level objectives, measure cost per successful task, and route only proven task classes to smaller models.",
    observableOutcome:
      "Quality, p95 latency, and cost tradeoffs become visible before routing complexity is expanded.",
  },
};

// Populate only after a talk has been reviewed against a timestamped source.
// Until then the UI deliberately falls back to an editorial track synthesis.
function getInsightContent(video: CatalogVideo, reviewedInsight?: TalkInsight): TalkInsight {
  const primaryTopic = video.track ?? videoTracks(video)[0];
  const approvedEvidence = (video.evidence ?? []).filter(
    (evidence) =>
      evidence.status === "approved" &&
      video.transcript?.status === "acquired" &&
      video.transcript.availability === "available" &&
      video.transcript.reviewStatus === "approved" &&
      video.transcript.reviewedAt !== null &&
      video.transcript.redistributionAllowed &&
      evidence.videoId === video.id &&
      evidence.transcriptDigest === video.transcript.digest,
  );
  const evidenceTimestamp = approvedEvidence[0]?.timestampSeconds ?? null;
  const evidenceReviewedAt = approvedEvidence[0]?.reviewedAt ?? null;
  // Metadata-only records must fail closed before any legacy/static insight
  // mapping is considered. Discovery metadata is not approval for claims.
  if (video.insightReviewStatus !== "approved") {
    return {
      claim: "No reviewed insight yet. This record contains approved source metadata only.",
      implication:
        "The Atlas intentionally withholds transcript-backed or speaker-attributed claims until Hermes/content review supplies approved evidence.",
      whenToUse:
        "Use the YouTube source link for the primary material. Do not treat this record as an editorial or transcript summary.",
      caveat:
        "Discovery and metadata publication do not approve an insight, a track classification, or an attribution.",
      example: {
        situation: "A new upload passed the approved channel and playlist identity policy.",
        application:
          "Publish only its metadata with an unclassified status while it awaits review.",
        observableOutcome: "The catalog updates without creating unsupported claims.",
      },
      contentBasis: "metadata_only",
      timestampSeconds: null,
      reviewedAt: null,
    };
  }
  if (reviewedInsight) return reviewedInsight;
  if (approvedEvidence.length) {
    const evidenceText = approvedEvidence.map((evidence) => evidence.text).join(" ");
    return {
      claim: evidenceText,
      implication:
        "The reviewed evidence is published as a concise paraphrase so the Atlas can connect the idea to a practical engineering decision without exposing the underlying transcript.",
      whenToUse:
        "Use this when you want to inspect the reviewed point in context, then open the source video for the full explanation and surrounding caveats.",
      caveat:
        "This is a reviewed paraphrase of one or more transcript moments, not a complete account of the talk.",
      example: {
        situation: "A team is deciding whether the reviewed pattern fits its own system.",
        application:
          "Compare the paraphrase with the source video, then test the pattern against local requirements and failure modes.",
        observableOutcome:
          "The decision records the source moment and the local evidence used to accept or reject the pattern.",
      },
      contentBasis: "transcript_backed",
      timestampSeconds: evidenceTimestamp,
      reviewedAt: evidenceReviewedAt,
    };
  }
  if (!primaryTopic) {
    return {
      claim: "No reviewed insight yet. This record contains approved source metadata only.",
      implication:
        "The Atlas intentionally withholds transcript-backed or speaker-attributed claims until Hermes/content review supplies approved evidence.",
      whenToUse:
        "Use the YouTube source link for the primary material. Do not treat this record as an editorial or transcript summary.",
      caveat:
        "Discovery and metadata publication do not approve an insight, a track classification, or an attribution.",
      example: {
        situation: "A new upload passed the approved channel and playlist identity policy.",
        application:
          "Publish only its metadata with an unclassified status while it awaits review.",
        observableOutcome: "The catalog updates without creating unsupported claims.",
      },
      contentBasis: "metadata_only",
      timestampSeconds: null,
      reviewedAt: null,
    };
  }
  return {
    ...TRACK_SUMMARIES[primaryTopic],
    example: TRACK_EXAMPLES[primaryTopic],
    contentBasis: "track_synthesis",
    timestampSeconds: null,
    reviewedAt: null,
  };
}

export function AtlasDashboard() {
  const [catalog, setCatalog] = useState<{
    records: readonly CatalogVideo[];
    source: "public_snapshot";
    verifiedAt: string;
  }>(() => ({
    records: [],
    source: "public_snapshot" as const,
    verifiedAt: "2026-07-30T00:00:00+08:00",
  }));
  const [query, setQuery] = useState("");
  const [semanticMatches, setSemanticMatches] = useState<PineconeTalkMatch[] | null>(null);
  const [selectedThemes, setSelectedThemes] = useState<Track[]>([]);
  const [year, setYear] = useState<"All" | number>("All");
  const [open, setOpen] = useState<CatalogVideo | null>(null);
  const lastCardTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const closeSummary = () => {
    setOpen(null);
    requestAnimationFrame(() => lastCardTriggerRef.current?.focus());
  };

  // Brief initial-load state so users see structure (skeletons) instead of a
  // pop-in of fully-rendered cards. Also gives images a beat to warm up.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadAtlasCatalog().then((result) => {
      if (!cancelled) {
        setCatalog({
          records: result.records,
          source: result.source,
          verifiedAt: result.manifest.sourceCatalogVerifiedAt,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(
    () => Array.from(new Set(catalog.records.map(videoYear))).sort((a, b) => b - a),
    [catalog.records],
  );

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 3) {
      setSemanticMatches(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void import("@/lib/pinecone-search")
        .then(({ searchApprovedInsights }) => searchApprovedInsights({ data: { query: normalized } }))
        .then((result) => {
          if (!cancelled) setSemanticMatches(result.available ? result.matches : null);
        })
        .catch(() => {
          if (!cancelled) setSemanticMatches(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const semanticByTalk = useMemo(() => {
    const grouped = new Map<string, PineconeTalkMatch[]>();
    for (const match of semanticMatches ?? []) {
      const matches = grouped.get(match.talkId) ?? [];
      matches.push(match);
      grouped.set(match.talkId, matches);
    }
    return grouped;
  }, [semanticMatches]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filteredCatalog = catalog.records.filter((v) => {
      const topics = videoThemes(v);
      if (selectedThemes.length && !selectedThemes.some((theme) => topics.includes(theme)))
        return false;
      if (year !== "All" && videoYear(v) !== year) return false;
      if (!q) return true;
      const metadataMatch =
        v.title.toLowerCase().includes(q) ||
        v.sourceChannel.toLowerCase().includes(q) ||
        topics.some((topic) => topic.toLowerCase().includes(q)) ||
        videoTags(v).some((tag) => atlasTagLabel(tag).includes(q));
      return metadataMatch || semanticByTalk.has(v.id);
    });
    if (q && semanticMatches) {
      return filteredCatalog.sort(
        (left, right) =>
          (semanticByTalk.get(right.id)?.[0]?.score ?? -Infinity) -
          (semanticByTalk.get(left.id)?.[0]?.score ?? -Infinity),
      );
    }
    return filteredCatalog;
  }, [catalog.records, query, selectedThemes, semanticByTalk, semanticMatches, year]);

  // Always start at PAGE_SIZE on both server and client to avoid a hydration
  // mismatch — the restored value from sessionStorage is applied in the
  // effect below, after hydration.
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);
  const [loadAnnouncement, setLoadAnnouncement] = useState("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollRef = useRef(false);

  useEffect(() => {
    // Restore visibleCount (post-hydration) so returning to the page keeps
    // the same amount of content mounted before we try to restore scroll.
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { count?: number };
        if (parsed.count && parsed.count > PAGE_SIZE) setVisibleCount(parsed.count);
      }
    } catch {
      // Session storage is optional; continue with the default page size.
    }
    const frame = requestAnimationFrame(() => setBooting(false));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Reset pagination whenever the filtered set changes so users always start
  // from the top of the new result list. Skip on the very first render so we
  // don't stomp the restored visibleCount from sessionStorage.
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false;
      return;
    }
    // Reset pagination so the new result set starts at PAGE_SIZE, but keep
    // the user's current scroll position — jumping to top on every keystroke
    // is jarring while searching.
    setVisibleCount(PAGE_SIZE);
  }, [query, selectedThemes, year]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  const loadMore = useCallback(() => {
    setVisibleCount((current) =>
      current >= filtered.length ? current : Math.min(current + PAGE_SIZE, filtered.length),
    );
  }, [filtered.length]);

  useEffect(() => {
    if (visibleCount <= PAGE_SIZE) return;
    setLoadAnnouncement(`Showing ${visibleCount} of ${filtered.length} talks.`);
  }, [filtered.length, visibleCount]);

  const loadIfNearViewport = useCallback(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const { top } = el.getBoundingClientRect();
    const nearEnd =
      window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1200;
    if (top <= window.innerHeight + 600 || nearEnd) loadMore();
  }, [loadMore]);

  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) loadMore();
            },
            { rootMargin: "600px 0px" },
          );
    io?.observe(el);
    window.addEventListener("scroll", loadIfNearViewport, { passive: true });
    window.addEventListener("resize", loadIfNearViewport);
    document.addEventListener("scroll", loadIfNearViewport, { passive: true });
    document.documentElement.addEventListener("scroll", loadIfNearViewport, { passive: true });
    document.body.addEventListener("scroll", loadIfNearViewport, { passive: true });
    loadIfNearViewport();
    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", loadIfNearViewport);
      window.removeEventListener("resize", loadIfNearViewport);
      document.removeEventListener("scroll", loadIfNearViewport);
      document.documentElement.removeEventListener("scroll", loadIfNearViewport);
      document.body.removeEventListener("scroll", loadIfNearViewport);
    };
  }, [hasMore, loadIfNearViewport, loadMore, visibleCount]);

  // Persist scroll position (throttled via rAF) and restore once the grid has
  // rendered enough cards to reach the saved offset.
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(
            SCROLL_KEY,
            JSON.stringify({ y: window.scrollY, count: visibleCount }),
          );
        } catch {
          // Browsers may deny session storage; scrolling should still work.
        }
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [visibleCount]);

  useEffect(() => {
    if (restoredScrollRef.current || booting) return;
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (!raw) {
        restoredScrollRef.current = true;
        return;
      }
      const { y } = JSON.parse(raw) as { y?: number };
      if (typeof y === "number" && y > 0) {
        // Wait a frame so the grid has painted before jumping.
        requestAnimationFrame(() => window.scrollTo({ top: y }));
      }
      restoredScrollRef.current = true;
    } catch {
      restoredScrollRef.current = true;
    }
  }, [booting]);

  useEffect(() => {
    if (!open) return;
    trackEvent("modal_open", {
      videoId: open.youtubeId,
      code: open.code,
      track: open.track,
      sourceChannel: open.sourceChannel,
    });
    const openedAt = performance.now();
    return () => {
      trackEvent("modal_close", {
        videoId: open.youtubeId,
        code: open.code,
        dwell_ms: Math.round(performance.now() - openedAt),
      });
    };
  }, [open]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

      if (
        event.defaultPrevented ||
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        isEditable
      ) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
    };

    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <div className="min-h-screen bg-paper text-ink" onWheel={loadIfNearViewport}>
      <AtlasNavigation current="insights" />

      <main>
        {/* HERO */}
        <section
          id="top"
          aria-label="AI Engineering Insight Atlas introduction"
          className="mx-auto max-w-[1400px] px-6 pt-4"
        >
          <h1 className="sr-only">AI Engineering Insights</h1>
          <div className="crosshair overflow-hidden rounded-xl border border-ink/90 bg-paper shadow-[0_20px_60px_-20px_rgba(20,20,40,0.25)]">
            <picture className="block bg-card">
              <source srcSet="/hero-themes-v2.webp" type="image/webp" />
              <img
                src="/hero-themes-v2.png"
                alt="Nine technical illustrations representing System Design, Data and Eval, Reliability, Observability, Safety and Control, Deployment, Knowledge, Developer Workflows and Models and Training."
                width={1536}
                height={1024}
                loading="eager"
                fetchPriority="high"
                decoding="async"
                className="block h-auto w-full"
              />
            </picture>
          </div>
          <div className="mt-4 rounded-xl border border-[color:var(--track-4)]/45 bg-card px-4 py-3 font-sans text-sm leading-relaxed text-muted-foreground">
            Source catalog was checked against YouTube on 15 Aug 2026. All rights belong to the
            respective owners.
          </div>
        </section>

        {/* Filters */}
        <section aria-labelledby="explore-title" className="mx-auto max-w-[1400px] px-6 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="explore-title" className="font-display text-2xl md:text-3xl">
                Find the talk behind the problem.
              </h2>
            </div>
            <span
              aria-live="polite"
              className="font-mono text-xs uppercase tracking-widest text-muted-foreground"
            >
              {String(visible.length).padStart(2, "0")} / {String(filtered.length).padStart(2, "0")}{" "}
              results
            </span>
          </div>

          {/* Search */}
          <div className="mt-6 flex flex-wrap gap-3">
            <label
              htmlFor="atlas-search"
              className="flex flex-1 min-w-[260px] items-center gap-3 rounded-xl border border-ink/20 bg-card px-4 py-3 shadow-[0_8px_24px_-12px_rgba(20,20,40,0.25)] transition-shadow focus-within:shadow-[0_12px_32px_-12px_rgba(20,20,40,0.35)]"
            >
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Search
              </span>
              <input
                ref={searchInputRef}
                id="atlas-search"
                type="search"
                placeholder='Try "evals" or "agents" or "RAG"'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 bg-transparent font-sans text-sm text-ink outline-none placeholder:text-muted-foreground/70"
              />
              <kbd className="hidden rounded-md border border-ink/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline">
                /
              </kbd>
            </label>
            <button
              onClick={() => {
                setQuery("");
                setSelectedThemes([]);
                setYear("All");
              }}
              className="rounded-xl border border-ink bg-ink px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-paper shadow-[0_8px_24px_-12px_rgba(20,20,40,0.5)] transition-transform hover:-translate-y-[1px]"
            >
              Reset
            </button>
          </div>

          {/* Track chips */}
          <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Filter by theme">
            <TrackChip
              label="All themes"
              active={selectedThemes.length === 0}
              onClick={() => setSelectedThemes([])}
            />
            {TRACKS.map((t) => (
              <TrackChip
                key={t.code}
                label={t.name}
                active={selectedThemes.includes(t.name)}
                onClick={() =>
                  setSelectedThemes((current) =>
                    current.includes(t.name)
                      ? current.filter((theme) => theme !== t.name)
                      : [...current, t.name],
                  )
                }
              />
            ))}
            <label className="ml-auto flex items-center gap-2 rounded-xl border border-ink/20 bg-card px-3 py-2 font-mono text-[11px] uppercase tracking-widest shadow-[0_6px_18px_-12px_rgba(20,20,40,0.25)]">
              Year
              <select
                value={year}
                onChange={(e) => setYear(e.target.value === "All" ? "All" : Number(e.target.value))}
                className="bg-transparent font-mono text-[11px] outline-none"
              >
                <option value="All">All</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Grid — only `visible` slice is mounted; sentinel below reveals more */}
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {booting
              ? Array.from({ length: PAGE_SIZE }).map((_, i) => <CardSkeleton key={`sk-${i}`} />)
              : visible.map((v, i) => {
                  const t = TRACKS.find((tr) => tr.name === videoThemes(v)[0]) ?? TRACKS[0]!;
                  const topics = videoThemes(v);
                  const tags = videoTags(v);
                  const eager = i < 3;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-labelledby={`card-title-${v.id}`}
                      onClick={(event) => {
                        lastCardTriggerRef.current = event.currentTarget;
                        setOpen(v);
                      }}
                      className="group flex flex-col overflow-hidden rounded-2xl border border-ink/15 bg-card text-left shadow-[0_10px_30px_-15px_rgba(20,20,40,0.35)] transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color:var(--ring)]/35 focus-visible:ring-offset-2 focus-visible:ring-offset-paper motion-safe:hover:-translate-y-[2px] hover:border-ink/40 hover:shadow-[0_18px_40px_-15px_rgba(20,20,40,0.45)]"
                    >
                      <div className="relative aspect-video overflow-hidden border-b border-ink/15 bg-muted">
                        <Thumbnail video={v} token={t.token} eager={eager} />
                        <span className="absolute bottom-3 right-3 rounded-md border border-ink bg-ink px-2 py-1 font-mono text-[10px] text-paper shadow-sm">
                          {videoDuration(v)}
                        </span>
                      </div>
                      <div className="flex flex-1 flex-col p-4">
                        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          <span>Talk</span>
                          <span>{videoPublishedDate(v)}</span>
                        </div>
                        <h3
                          id={`card-title-${v.id}`}
                          className="mt-2 font-display text-lg leading-tight"
                        >
                          {v.title}
                        </h3>
                        <p className="mt-2 font-sans text-sm text-muted-foreground">
                          YouTube · {v.sourceChannel}
                        </p>
                        <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-ink/10 pt-3 font-mono text-[11px] uppercase tracking-widest">
                          <span className="flex flex-wrap gap-x-3 gap-y-1">
                            {topics.length ? (
                              topics.map((topic) => {
                                return (
                                  <span
                                    key={topic}
                                    className="inline-flex items-center gap-1.5 text-ink"
                                  >
                                    <TrackIcon track={topic} className="h-3.5 w-3.5" />
                                    {topic}
                                  </span>
                                );
                              })
                            ) : (
                              <span className="text-muted-foreground">
                                {tags.map(atlasTagLabel).join(" · ")}
                              </span>
                            )}
                          </span>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap text-ink group-hover:underline">
                            <span>Summary</span>
                            <span aria-hidden="true" className="tracking-normal">
                              →
                            </span>
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
            {!booting &&
              hasMore &&
              Array.from({ length: Math.min(3, filtered.length - visibleCount) }).map((_, i) => (
                <CardSkeleton key={`sk-more-${i}`} />
              ))}
          </div>

          {/* Sentinel — IntersectionObserver reveals the next page when it
            approaches the viewport. When exhausted, shows an end marker. */}
          <span className="sr-only" aria-live="polite">
            {loadAnnouncement}
          </span>
          {!booting && hasMore ? (
            <div
              ref={sentinelRef}
              data-testid="atlas-infinite-scroll-sentinel"
              className="mt-10 flex justify-center pb-24"
            >
              <span
                aria-hidden="true"
                className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
              >
                Loading more talks…
              </span>
            </div>
          ) : (
            !booting &&
            filtered.length > 0 && (
              <div className="mt-10 flex justify-center pb-24">
                <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  End of atlas · {filtered.length} talks
                </span>
              </div>
            )
          )}

          {filtered.length === 0 && (
            <div className="rounded-2xl border border-dashed border-ink/40 p-12 text-center font-mono text-sm text-muted-foreground">
              No talks match. Try resetting filters.
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-ink/20">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-6 py-6 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
          <span>© AI Engineering Insights</span>
          <span className="flex items-center gap-4">
            <span>Built to keep up with the AI space</span>
          </span>
        </div>
      </footer>

      {open && (
        <SummaryModal video={open} matches={semanticByTalk.get(open.id) ?? []} onClose={closeSummary} />
      )}
    </div>
  );
}

function TrackChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={
        "inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 py-2 font-mono text-[11px] uppercase tracking-widest transition-all " +
        (active
          ? "border-ink bg-ink text-paper shadow-[0_8px_20px_-10px_rgba(20,20,40,0.6)]"
          : "border-ink/20 bg-card text-ink shadow-[0_4px_14px_-10px_rgba(20,20,40,0.35)] hover:-translate-y-[1px] hover:border-ink/50")
      }
    >
      {label !== "All themes" && <TrackIcon track={label as Track} className="h-4 w-4" />}
      {label}
    </button>
  );
}

function TrackIcon({ track, className = "h-4 w-4" }: { track: Track; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
  };
  if (track === "System Design")
    return (
      <svg {...common}>
        <path d="m4 7 8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 17l8 4 8-4" />
      </svg>
    );
  if (track === "Data & Eval")
    return (
      <svg {...common}>
        {[6, 12, 18].flatMap((y) =>
          [6, 12, 18].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={x === y ? 1.8 : 1} />),
        )}
      </svg>
    );
  if (track === "Reliability")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="7" />
        <path d="M12 1v22M1 12h22" />
        <circle cx="17" cy="7" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  if (track === "Observability")
    return (
      <svg {...common}>
        <path d="m2 17 5-6 4 3 5-9 6 7" />
        <path d="M3 22v-3m5 3v-5m5 5v-4m5 4v-7m4 7v-5" />
      </svg>
    );
  if (track === "Safety & Control")
    return (
      <svg {...common}>
        <rect x="2" y="2" width="4" height="4" />
        <rect x="18" y="2" width="4" height="4" />
        <rect x="2" y="18" width="4" height="4" />
        <rect x="18" y="18" width="4" height="4" />
        <path d="m12 7 5 5-5 5-5-5 5-5ZM6 4h12M4 6v12m16-12v12M6 20h12" />
      </svg>
    );
  if (track === "Knowledge")
    return (
      <svg {...common}>
        <path d="M4 6h16v12H4zM8 10h8M8 14h5" />
        <path d="M7 3v3m10-3v3m-7 12v3m4-3v3" />
      </svg>
    );
  if (track === "Developer Workflows")
    return (
      <svg {...common}>
        <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />
      </svg>
    );
  if (track === "Models & Training")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.9 4.9l2.8 2.8m8.6 8.6 2.8 2.8m0-14.2-2.8 2.8m-8.6 8.6-2.8 2.8" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="m3 8 5-3 5 3-5 3-5-3Zm0 0v6l5 3 5-3V8M13 8l4-2 4 2-4 3-4-3Zm0 6 4-3 4 3-4 3-4-3Zm0 0v6l4 2 4-2v-6" />
    </svg>
  );
}

// Loads the YouTube IFrame API once so we can listen for caption state
// changes on any embedded player. The first load is timed as a perf mark.
type YouTubePlayerEvent = { data?: unknown };
type YouTubePlayer = {
  destroy?: () => void;
  getOption?: (module: string, option: string) => unknown;
};
type YouTubeApi = {
  Player: new (
    element: HTMLIFrameElement,
    options: {
      events: {
        onApiChange: () => void;
        onError: (event: YouTubePlayerEvent) => void;
        onReady: () => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayer;
};
type WindowWithYouTube = Window & {
  YT?: YouTubeApi;
  onYouTubeIframeAPIReady?: () => void;
};

let ytApiPromise: Promise<YouTubeApi> | null = null;
function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  const w = window as WindowWithYouTube;
  if (w.YT && w.YT.Player) return Promise.resolve(w.YT);
  if (ytApiPromise) return ytApiPromise;
  const endMark = perfMark("yt_api_load");
  ytApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      endMark({ outcome: "ok" });
      if (w.YT) resolve(w.YT);
      else reject(new Error("YouTube API loaded without a Player constructor"));
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = (e) => {
      endMark({ outcome: "error" });
      logClientError("youtube_api_load_failed", {}, e);
      reject(new Error("Failed to load YouTube IFrame API"));
    };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

function EmbeddedPlayer({ video }: { video: Video }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const captionsActive = useRef(false);
  const captionsLang = useRef<string | null>(null);
  const playReported = useRef(false);
  const captionsProbeEnd = useRef<((extra?: Record<string, unknown>) => number) | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    captionsActive.current = false;
    captionsLang.current = null;
    playReported.current = false;
    if (!iframeRef.current) return;
    let player: YouTubePlayer | undefined;
    let cancelled = false;
    const readyEnd = perfMark("player_ready", { videoId: video.youtubeId });
    // Captions module loads asynchronously after playback starts. We start a
    // timer at player-ready and close it the first time captions surface,
    // giving us a "how long from playback to CC available" measurement.
    captionsProbeEnd.current = perfMark("captions_probe", {
      videoId: video.youtubeId,
    });

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !iframeRef.current) return;
        player = new YT.Player(iframeRef.current, {
          events: {
            onReady: () => {
              readyEnd({ outcome: "ok" });
            },
            onError: (ev: YouTubePlayerEvent) => {
              readyEnd({ outcome: "error", errorCode: ev?.data });
              logClientError("youtube_player_error", {
                videoId: video.youtubeId,
                code: video.code,
                errorCode: ev?.data,
              });
              setFailed(true);
            },
            onStateChange: (ev: YouTubePlayerEvent) => {
              // YT.PlayerState.PLAYING === 1
              if (ev?.data === 1 && !playReported.current) {
                playReported.current = true;
                trackEvent("player_play", {
                  videoId: video.youtubeId,
                  code: video.code,
                  track: video.track,
                });
              }
            },
            onApiChange: () => {
              try {
                const opt =
                  player?.getOption?.("captions", "track") ?? player?.getOption?.("cc", "track");
                const optionRecord =
                  typeof opt === "object" && opt !== null ? (opt as Record<string, unknown>) : null;
                const hasTrack = optionRecord !== null && Object.keys(optionRecord).length > 0;
                const lang =
                  hasTrack && typeof optionRecord.languageCode === "string"
                    ? optionRecord.languageCode
                    : null;

                if (hasTrack && !captionsActive.current) {
                  captionsActive.current = true;
                  captionsLang.current = lang;
                  captionsProbeEnd.current?.({ outcome: "captions_available" });
                  captionsProbeEnd.current = null;
                  trackEvent("captions_enabled", {
                    videoId: video.youtubeId,
                    code: video.code,
                    track: video.track,
                    language: lang,
                    dedupe: video.youtubeId,
                  });
                } else if (!hasTrack && captionsActive.current) {
                  // User toggled captions off.
                  captionsActive.current = false;
                  trackEvent("captions_disabled", {
                    videoId: video.youtubeId,
                    code: video.code,
                    language: captionsLang.current,
                    dedupe: video.youtubeId,
                  });
                  captionsLang.current = null;
                } else if (hasTrack && lang && lang !== captionsLang.current) {
                  // User switched caption language.
                  const prevLang = captionsLang.current;
                  captionsLang.current = lang;
                  trackEvent("captions_language_changed", {
                    videoId: video.youtubeId,
                    from: prevLang,
                    to: lang,
                  });
                }
              } catch (err) {
                logClientError("captions_probe_failed", { videoId: video.youtubeId }, err);
              }
            },
          },
        });
      })
      .catch(() => {
        readyEnd({ outcome: "api_load_failed" });
        setFailed(true);
      });
    return () => {
      cancelled = true;
      // If captions never surfaced, close the probe with an outcome so the
      // debug page shows how long we waited before teardown.
      captionsProbeEnd.current?.({ outcome: "unmounted" });
      captionsProbeEnd.current = null;
      try {
        player?.destroy?.();
      } catch {
        // The iframe API may already have disposed the player.
      }
    };
  }, [video]);

  if (failed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink p-6 text-center font-sans text-sm text-paper">
        <div>The embedded player couldn’t load.</div>
        <a
          href={`https://www.youtube.com/watch?v=${video.youtubeId}`}
          target="_blank"
          rel="noreferrer"
          onClick={() =>
            trackEvent("open_on_youtube_click", {
              videoId: video.youtubeId,
              from: "player_fallback",
            })
          }
          className="rounded-full border border-paper/40 px-3 py-1 text-xs uppercase tracking-widest hover:bg-paper hover:text-ink"
        >
          Watch on YouTube ↗
        </a>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?rel=0&modestbranding=1&enablejsapi=1`}
      title={video.title}
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      onError={() => {
        logClientError("iframe_error", { videoId: video.youtubeId });
        setFailed(true);
      }}
      className="absolute inset-0 h-full w-full"
    />
  );
}

function SummaryModal({
  video,
  matches,
  onClose,
}: {
  video: CatalogVideo;
  matches: PineconeTalkMatch[];
  onClose: () => void;
}) {
  const themes = videoThemes(video);
  const tags = videoTags(video);
  const [insight, setInsight] = useState<TalkInsight | null>(() =>
    video.insightReviewStatus === "approved" ? null : getInsightContent(video),
  );
  useEffect(() => {
    let cancelled = false;
    if (video.insightReviewStatus !== "approved") {
      setInsight(getInsightContent(video));
      return;
    }
    setInsight(null);
    void loadTalkInsight(video).then((reviewedInsight) => {
      if (!cancelled) setInsight(getInsightContent(video, reviewedInsight));
    });
    return () => {
      cancelled = true;
    };
  }, [video]);
  const timestamp = (seconds: number) =>
    new Date(seconds * 1000).toISOString().slice(seconds >= 3600 ? 11 : 14, 19);
  const matchedTextFor = (field: PineconeTalkMatch["matchedField"]) =>
    matches.filter((match) => match.matchedField === field).map((match) => match.matchedText);
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          onClick={onClose}
          className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm"
        />
        <DialogPrimitive.Content className="fixed inset-0 z-50 w-full overflow-y-auto bg-paper focus:outline-none sm:left-1/2 sm:top-1/2 sm:h-[75vh] sm:max-h-[75vh] sm:max-w-[1000px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border">
          <div className="sticky top-0 z-10 flex min-h-14 items-center justify-between border-b border-ink/15 bg-card px-6 py-3">
            <span className="font-mono text-[11px] uppercase tracking-widest text-ink">
              {themes.length ? `Category: ${themes.join(" · ")}` : "Category: Unassigned"}
            </span>
            <DialogPrimitive.Close className="min-h-11 rounded-lg px-3 font-mono text-[11px] uppercase tracking-widest">
              Close ✕
            </DialogPrimitive.Close>
          </div>
          <div className="grid gap-6 border-b border-ink/15 p-6 md:grid-cols-2">
            <div>
              <DialogPrimitive.Title className="font-display text-3xl">
                {video.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 font-sans text-sm text-muted-foreground">
                <span>Published {videoPublishedDate(video)}</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock aria-hidden="true" className="h-4 w-4" strokeWidth={1.75} />
                  <span>{videoDuration(video)}</span>
                </span>
              </DialogPrimitive.Description>
              {tags.length > 0 && (
                <div className="mt-3">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Tags
                  </div>
                  <div className="mt-2 grid gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-2">
                        <TrackIcon track={atlasTagTheme(tag)} className="h-3.5 w-3.5 text-ink" />
                        <span>{atlasTagLabel(tag)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="relative aspect-video overflow-hidden rounded-xl bg-ink">
              <EmbeddedPlayer video={video} />
            </div>
          </div>
          <div className="p-6">
            <section
              aria-labelledby={`insight-title-${video.id}`}
              className="border-b border-ink/15 pb-6"
            >
              <h3 id={`insight-title-${video.id}`} className="mt-2 font-display text-xl">
                Insight
              </h3>
              {insight ? (
                <>
                  <InsightBody
                    body={`${insight.claim}${
                      insight.timestampSeconds !== null &&
                      !hasTimestampReference(insight.claim, timestamp(insight.timestampSeconds))
                        ? ` (${timestamp(insight.timestampSeconds)})`
                        : ""
                    }`}
                    className="mt-3 font-sans text-[15px] leading-relaxed text-ink"
                    highlightTexts={matchedTextFor("claim")}
                  />
                  <div className="mt-5 space-y-5">
                    <ExamplePart
                      label="Why it matters"
                      body={insight.implication}
                      divider={false}
                      leadOnly
                      highlightTexts={matchedTextFor("implication")}
                    />
                    <ExamplePart
                      label="Use it when"
                      body={insight.whenToUse}
                      divider={false}
                      leadOnly
                      hideLead
                      highlightTexts={matchedTextFor("whenToUse")}
                    />
                  </div>
                  <div className="mt-5 border-t border-ink/10 pt-4">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Caveat
                    </div>
                    <InsightBody
                      body={insight.caveat}
                      className="mt-1 font-sans text-sm leading-relaxed text-muted-foreground"
                      highlightTexts={matchedTextFor("caveat")}
                    />
                  </div>
                </>
              ) : (
                <div
                  aria-live="polite"
                  className="mt-4 space-y-5"
                  aria-label="Loading reviewed insight"
                >
                  <span className="sr-only">Loading reviewed insight</span>
                  <div className="space-y-2" aria-hidden="true">
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="space-y-2 border-t border-ink/10 pt-4" aria-hidden="true">
                    <div className="h-2.5 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  </div>
                </div>
              )}
            </section>
            {insight ? (
              <a
                href={`https://www.youtube.com/watch?v=${video.youtubeId}`}
                target="_blank"
                rel="noreferrer"
                className="mt-6 flex w-full items-center justify-between rounded-xl border border-ink bg-ink px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-paper"
              >
                Open on YouTube <span>↗</span>
              </a>
            ) : (
              <div
                aria-hidden="true"
                data-testid="modal-action-skeleton"
                className="mt-6 h-11 w-full animate-pulse rounded-xl bg-muted"
              />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ExamplePart({
  label,
  body,
  divider = true,
  leadOnly = false,
  hideLead = false,
  highlightTexts,
}: {
  label: string;
  body: string;
  divider?: boolean;
  leadOnly?: boolean;
  hideLead?: boolean;
  highlightTexts?: string[];
}) {
  return (
    <div className={divider ? "border-t border-ink/10 pt-3" : "pt-0"}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <InsightBody
        body={body}
        className="mt-1 font-sans text-sm leading-relaxed text-ink"
        leadOnly={leadOnly}
        hideLead={hideLead}
        highlightTexts={highlightTexts}
      />
    </div>
  );
}

function InsightBody({
  body,
  className,
  leadOnly = false,
  hideLead = false,
  highlightTexts = [],
}: {
  body: string;
  className: string;
  leadOnly?: boolean;
  hideLead?: boolean;
  highlightTexts?: string[];
}) {
  const numbered = parseNumberedInsightText(body);
  const highlightClass = "rounded-md bg-amber-100 px-1.5 py-0.5 box-decoration-clone";
  const renderedText = (text: string) => (
    <HighlightedInsightText
      text={text}
      highlightTexts={highlightTexts}
      highlightClass={highlightClass}
    />
  );

  if (numbered.points.length > 1) {
    if (numbered.lead && leadOnly) {
      return (
        <>
          {!hideLead && (
            <p className={className}>{renderedText(numbered.lead)}</p>
          )}
          <ol
            className={`${className} insight-numbered-list insight-numbered-list--nested space-y-2`}
          >
            {numbered.points.map((point, index) => (
              <li key={`${index}-${point}`}>
                <span className="insight-numbered-label">{index + 1}.</span>
                {renderedText(
                  capitalizeFirstAlphabet(index === 1 ? consolidateTimestampGroups(point) : point),
                )}
              </li>
            ))}
          </ol>
        </>
      );
    }

    if (numbered.lead) {
      return (
        <ol className={`${className} insight-numbered-list space-y-2`}>
          <li>
            <span className="insight-numbered-label">1.</span>
            {renderedText(numbered.lead)}
            <ol className="insight-numbered-list insight-numbered-list--nested mt-2 space-y-2">
              {numbered.points.map((point, index) => (
                <li key={`${index}-${point}`}>
                  <span className="insight-numbered-label">1.{index + 1}</span>
                  {renderedText(
                    capitalizeFirstAlphabet(index === 1 ? consolidateTimestampGroups(point) : point),
                  )}
                </li>
              ))}
            </ol>
          </li>
        </ol>
      );
    }

    return (
      <ol className={`${className} insight-numbered-list space-y-2`}>
        {numbered.points.map((point, index) => (
          <li key={`${index}-${point}`}>
            <span className="insight-numbered-label">{index + 1}.</span>
            {renderedText(
              capitalizeFirstAlphabet(index === 1 ? consolidateTimestampGroups(point) : point),
            )}
          </li>
        ))}
      </ol>
    );
  }

  const points = splitInsightSentences(body);

  if (points.length > 1) {
    return (
      <ol className={`${className} insight-numbered-list space-y-2`}>
        {points.map((point, index) => (
          <li key={`${index}-${point}`}>
            <span className="insight-numbered-label">{index + 1}.</span>
            {renderedText(capitalizeFirstAlphabet(point))}
          </li>
        ))}
      </ol>
    );
  }

  return <p className={className}>{renderedText(body)}</p>;
}

function HighlightedInsightText({
  text,
  highlightTexts,
  highlightClass,
}: {
  text: string;
  highlightTexts: string[];
  highlightClass: string;
}) {
  const normalizedHighlights = new Set(highlightTexts.map((value) => value.trim().toLowerCase()));
  const sentences = splitInsightSentences(text);
  const isHighlighted = (value: string) => normalizedHighlights.has(value.trim().toLowerCase());

  if (sentences.length <= 1) {
    return <>{isHighlighted(text) ? <span className={highlightClass}>{text}</span> : text}</>;
  }

  return (
    <>
      {sentences.map((sentence, index) => (
        <span key={`${index}-${sentence}`} className={isHighlighted(sentence) ? highlightClass : undefined}>
          {index > 0 ? " " : ""}
          {sentence}
        </span>
      ))}
    </>
  );
}

function capitalizeFirstAlphabet(text: string): string {
  const index = text.search(/[A-Za-z]/);
  if (index < 0) return text;
  return `${text.slice(0, index)}${text[index]!.toUpperCase()}${text.slice(index + 1)}`;
}

function Row({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 px-6 py-5 md:grid-cols-[140px_1fr] md:px-8">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-sans text-[15px] leading-relaxed text-ink">{body}</div>
    </div>
  );
}

function SideBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 border-b border-ink/10 pb-4 last:border-b-0">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
