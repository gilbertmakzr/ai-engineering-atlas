import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CATALOG_PATH = resolve("src/data/atlas-public-catalog.json");

const THEMES = {
  ZTA0GwpAUak: ["Knowledge", "Models & Training"],
  I3bpdgFJCUY: ["Knowledge"],
  XEd_SRVHBgU: ["Models & Training"],
  I6aiEf3aEFQ: ["Knowledge", "Models & Training"],
  WiqDvX6isc4: ["Knowledge", "Models & Training"],
  "R3-anFK1YM8": ["Knowledge", "Developer Workflows"],
  zL1kLftVTlo: ["Models & Training"],
  iqloyWCGYQQ: ["Data & Eval", "Models & Training"],
  K0X9QDRkIdg: ["System Design", "Developer Workflows"],
  aeTb5BdmTTc: ["Developer Workflows", "System Design"],
  maRzp4kImJ4: ["Models & Training", "Deployment"],
  shRR1e2HXMk: ["Developer Workflows", "Reliability"],
  OL7kfezynJM: ["Developer Workflows", "System Design"],
  "03l29gJXpCE": ["Data & Eval", "Safety & Control"],
  Kz4QJmNrVXU: ["Developer Workflows"],
  vSx5IULvBns: ["Reliability", "Deployment"],
  iQ5xldZ9StU: ["Developer Workflows", "System Design"],
  "7vn4WpqNpck": ["Data & Eval", "Developer Workflows"],
  "Z-c11pV_uvU": ["Data & Eval", "Safety & Control"],
  LZuWZRze3MU: ["System Design", "Developer Workflows"],
  CoEIs6Xm8m8: ["Developer Workflows"],
  FWMJQDH3iK0: ["Models & Training", "Safety & Control", "Deployment"],
  J4_jCrTxMkk: ["Models & Training", "Deployment"],
  QHBjufYK8TA: ["System Design", "Models & Training"],
  RmS5s6Wbin4: ["Developer Workflows", "Safety & Control"],
  "2aS7aKoXn64": ["Data & Eval", "Developer Workflows"],
  "cJ0EOzey--o": ["Models & Training"],
  _PdK6x7PQNM: ["Data & Eval", "Models & Training"],
  k35LeKZEhiE: ["Models & Training", "Data & Eval"],
  ewtOo0scUh0: ["Models & Training", "Data & Eval"],
  "2bvtay8wGYI": ["Models & Training", "Reliability"],
  zkX03APVj0M: ["Developer Workflows", "Data & Eval", "Models & Training"],
  xbPriQWXtWM: ["Models & Training"],
  "3ZMUiFaQ3qg": ["Data & Eval", "Safety & Control"],
  lCBf9slCanI: ["Data & Eval", "Safety & Control"],
  "jWq-aZIU0kM": ["Data & Eval"],
  AQv3qRCG6Gw: ["Models & Training", "Data & Eval", "Safety & Control"],
  AVMr9PMINyo: ["System Design", "Models & Training", "Deployment"],
  AMiyLItEtLA: ["Data & Eval"],
  pWXUkLP9uWM: ["Models & Training", "Developer Workflows"],
  z0sh8HyTrDo: ["System Design", "Developer Workflows"],
  tJFjeMBKbIY: ["System Design"],
  o6U_2vd967Y: ["System Design", "Developer Workflows"],
  s67bE2Ur3bY: ["System Design"],
  iKQ78wyJEXU: ["Developer Workflows", "Safety & Control"],
  Tt2kX2sgQio: ["Safety & Control", "Data & Eval"],
  YnNF55QV0zs: ["Models & Training", "Safety & Control"],
  Owb8g3yDyzo: ["Knowledge", "Safety & Control"],
  KMR_RBoCa4M: ["Developer Workflows", "Reliability"],
  "7jjudsEhBtM": ["Developer Workflows"],
  kiqubc5b5Yo: ["System Design", "Models & Training"],
  BInpv7lGp1o: ["Developer Workflows", "Reliability"],
  "wpOA-UXynoM": ["Developer Workflows", "System Design"],
  l0FLhNqBOic: ["Developer Workflows", "System Design"],
  RVxym6mmIns: ["Developer Workflows", "System Design"],
  ITMXwI6QL6A: ["Developer Workflows", "System Design"],
  Byv311hdoHE: ["Developer Workflows", "System Design"],
  "7wu2hsRfvV0": ["Developer Workflows", "System Design"],
  "1OMHGsUZiqA": ["Developer Workflows", "System Design"],
  KwhgfwOSToQ: ["Developer Workflows", "System Design"],
  lyL5QhgIOxc: ["Deployment", "Reliability"],
  NOONz6SwKKg: ["Models & Training"],
  dQmseZ6kz8w: ["System Design"],
} as const;

type Theme = (typeof THEMES)[keyof typeof THEMES][number];
type CatalogRecord = {
  youtubeId: string;
  themes: Theme[];
  tracks: Theme[];
  contentStatus: "metadata_only" | string;
  themeClassification?: unknown;
};
type Catalog = { manifest: globalThis.Record<string, unknown>; records: CatalogRecord[] };

const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8")) as Catalog;
const unclassified = catalog.records.filter((record) => record.themes.length === 0);
const missing = unclassified.filter((record) => !(record.youtubeId in THEMES));
if (missing.length) {
  throw new Error(
    `Missing metadata-review themes for: ${missing.map((record) => record.youtubeId).join(", ")}`,
  );
}

const metadataOnly = catalog.records.filter(
  (candidate) => candidate.contentStatus === "metadata_only",
);
for (const record of metadataOnly) {
  if (record.themes.length === 0) {
    const themes = [...THEMES[record.youtubeId as keyof typeof THEMES]] as Theme[];
    record.themes = themes;
    record.tracks = themes;
  }
  record.themeClassification = {
    source: "metadata_taxonomy",
    basis: "title_and_context_review",
    classifiedAt: new Date().toISOString(),
    classifierVersion: "atlas-metadata-taxonomy-2026-08-15",
  };
}

const temporary = `${CATALOG_PATH}.tmp`;
await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
await rename(temporary, CATALOG_PATH);
console.log(
  `Categorized ${unclassified.length} and labelled ${metadataOnly.length} metadata-only Atlas records.`,
);
