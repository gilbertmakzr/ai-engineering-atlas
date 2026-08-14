import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import publicCatalog from "../src/data/atlas-public-catalog.json";
import { TALK_INSIGHTS } from "../src/data/talk-insights";

type PublicCatalogRecord = (typeof publicCatalog.records)[number];

function publicInsightProjection() {
  const records = Object.fromEntries(
    (publicCatalog.records as PublicCatalogRecord[])
      .filter((video) => video.insightReviewStatus === "approved")
      .flatMap((video) => {
        const insight = TALK_INSIGHTS[video.id] ?? TALK_INSIGHTS[`youtube-${video.youtubeId}`];
        if (!insight) return [];
        // This is a display projection, not a backup of the authoring corpus.
        // Keep only fields already rendered in the public modal. Review metadata
        // and any unlisted legacy records remain in the protected source file.
        return [
          [
            video.id,
            {
              claim: insight.claim,
              implication: insight.implication,
              whenToUse: insight.whenToUse,
              caveat: insight.caveat,
              example: insight.example,
              contentBasis: insight.contentBasis,
              timestampSeconds: insight.timestampSeconds,
              reviewedAt: null,
            },
          ],
        ];
      }),
  );
  return { records };
}

export async function generatePublicProjections() {
  const outputs = [
    { path: resolve("public/atlas-public-catalog.json"), payload: publicCatalog },
    { path: resolve("public/talk-insights.json"), payload: publicInsightProjection() },
  ];
  for (const output of outputs) {
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, `${JSON.stringify(output.payload)}\n`);
  }
  return outputs.length;
}

if (import.meta.main)
  console.log(`Generated ${await generatePublicProjections()} public Atlas projections.`);
