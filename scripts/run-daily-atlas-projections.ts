import { runYouTubeMetadataDiscovery } from "./discover-video-sources";
import { runYouTubeCatalogReconciliation } from "./discover-youtube-videos";
import { generatePublicProjections } from "./generate-public-projections";

export async function runDailyAtlasProjections(
  options: {
    discovery?: () => ReturnType<typeof runYouTubeMetadataDiscovery>;
    reconcile?: () => ReturnType<typeof runYouTubeCatalogReconciliation>;
    generate?: () => Promise<number>;
  } = {},
) {
  const discovery = await (options.discovery ?? runYouTubeMetadataDiscovery)();
  if (discovery.status !== "completed") {
    throw new Error(
      "Daily Atlas run refused: YOUTUBE_DISCOVERY_ENABLED=1 and ATLAS_DISCOVERY_SCHEDULE_ENABLED=true are both required.",
    );
  }
  const reconciliation = await (options.reconcile ?? runYouTubeCatalogReconciliation)();
  if (reconciliation.status !== "completed") {
    throw new Error("Daily Atlas run refused: catalog reconciliation is disabled.");
  }
  // Discovery errors reject before this point. This generator imports reviewed
  // tracked sources only; no candidate state is an input to the public projection.
  const generated = await (options.generate ?? generatePublicProjections)();
  return { discovery, reconciliation, generated };
}

if (import.meta.main) {
  const result = await runDailyAtlasProjections();
  console.log(
    `Daily Atlas run completed: ${result.discovery.candidatesAdded} newest candidate(s), ${result.reconciliation.published} metadata record(s) published, ${result.generated} reviewed projections.`,
  );
}
