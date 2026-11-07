import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);

const nodeRequire = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function load(path, doubles = {}) {
  const { outputText } = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const module = { exports: {} };
  const require = (name) => {
    if (name in doubles) return doubles[name];
    assert.ok(!name.startsWith("."), `${path} imports ${name} without a test double`);
    return nodeRequire(name);
  };
  new Function("require", "module", "exports", outputText)(require, module, module.exports);
  return module.exports;
}

const utils = load("src/utils/albumStatistics.ts");

function i18nFor(locale) {
  return { useI18n: () => ({ locale }) };
}

function labelsFor(locale) {
  return load("src/i18n/albumStatistics.ts", {
    "./index": i18nFor(locale),
  }).useAlbumStatisticsLabels();
}

function account(id, overrides = {}) {
  return {
    id,
    serverUrl: `https://${id}.example`,
    userId: `user-${id}`,
    userName: null,
    userEmail: null,
    authType: "api_key",
    isPrimary: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function accountStats(accountId, overrides = {}) {
  return {
    accountId,
    albumCount: 0,
    sharedAlbumCount: 0,
    unsyncedAlbumCount: 0,
    assetsInAlbums: 0,
    assetsNotInAlbums: 0,
    ...overrides,
  };
}

const sampleStats = {
  albumCount: 5,
  sharedAlbumCount: 2,
  unsyncedAlbumCount: 1,
  assetsInAlbums: 1200,
  assetsNotInAlbums: 800,
  accounts: [
    accountStats("a", {
      albumCount: 4,
      sharedAlbumCount: 2,
      unsyncedAlbumCount: 1,
      assetsInAlbums: 1000,
      assetsNotInAlbums: 500,
    }),
    accountStats("gone", { albumCount: 1, assetsInAlbums: 200, assetsNotInAlbums: 300 }),
  ],
};

test("ratioOf guards empty totals and clamps to one", () => {
  assert.equal(utils.ratioOf(5, 0), 0);
  assert.equal(utils.ratioOf(0, 10), 0);
  assert.equal(utils.ratioOf(-1, 10), 0);
  assert.equal(utils.ratioOf(Number.NaN, 10), 0);
  assert.equal(utils.ratioOf(3, 4), 0.75);
  assert.equal(utils.ratioOf(12, 4), 1);
});

test("donutArcs splits the circumference into consecutive segments", () => {
  const arcs = utils.donutArcs([1, 0, 3, -2], 100);
  assert.deepEqual(
    arcs.map((arc) => arc.length),
    [25, 0, 75, 0],
  );
  assert.deepEqual(
    arcs.map((arc) => Math.abs(arc.offset)),
    [0, 25, 25, 100],
  );
  assert.deepEqual(
    utils.donutArcs([0, 0], 100).map((arc) => arc.length),
    [0, 0],
  );
});

test("buildAccountRows keeps signed-in order, zero accounts, and orphaned data", () => {
  const rows = utils.buildAccountRows(
    sampleStats,
    [
      account("empty", { userEmail: "empty@example.com" }),
      account("a", { userName: "Alice", userEmail: "alice@example.com" }),
    ],
    "Signed out",
  );

  assert.deepEqual(
    rows.map((row) => [row.accountId, row.label, row.serverUrl, row.totalAssets, row.albumCount]),
    [
      ["empty", "empty@example.com", "https://empty.example", 0, 0],
      ["a", "Alice", "https://a.example", 1500, 4],
      ["gone", "Signed out", null, 500, 1],
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.color),
    utils.ACCOUNT_CHART_COLORS.slice(0, 3),
  );
});

test("buildAccountRows cycles colors and falls back to the user id", () => {
  const accounts = Array.from({ length: utils.ACCOUNT_CHART_COLORS.length + 1 }, (_, index) =>
    account(`id-${index}`),
  );
  const rows = utils.buildAccountRows({ ...sampleStats, accounts: [] }, accounts, "?");
  assert.equal(rows[0].label, "user-id-0");
  assert.deepEqual(rows.at(-1).color, utils.ACCOUNT_CHART_COLORS[0]);
});

test("numbers and percentages follow the app locale", () => {
  assert.equal(utils.formatCount(1234567, "en-CA"), "1,234,567");
  assert.equal(utils.formatCount(1234567, "fr-CA").replace(/\s/g, " "), "1 234 567");
  assert.equal(utils.formatPercent(0.6, "en-CA"), "60%");
  assert.equal(utils.formatPercent(0.1234, "en-CA"), "12.3%");
});

test("labels pluralize in English and French", () => {
  const en = labelsFor("en-CA");
  const fr = labelsFor("fr-CA");
  assert.equal(en.albumCount(1, "1"), "1 album");
  assert.equal(en.albumCount(0, "0"), "0 albums");
  assert.equal(fr.albumCount(0, "0"), "0 album");
  assert.equal(fr.shared(2, "2"), "2 partagés");
  assert.match(en.unsynced(1, "1"), /^1 album has not loaded/);
  assert.match(en.unsynced(3, "3"), /^3 albums have not loaded/);
  assert.match(fr.unsynced(2, "2"), /^2 albums n’ont pas encore/);
});

function loadCard(query, locale = "en-CA") {
  const i18n = i18nFor(locale);
  const labelsModule = load("src/i18n/albumStatistics.ts", { "./index": i18n });
  const charts = {
    "../Charts/DonutChart": load("src/components/Charts/DonutChart.tsx", {
      "../../utils/albumStatistics": utils,
    }),
    "../Charts/StackedBar": load("src/components/Charts/StackedBar.tsx", {
      "../../utils/albumStatistics": utils,
    }),
    "../Charts/ChartLegend": load("src/components/Charts/ChartLegend.tsx"),
  };
  const shared = { "../../utils/albumStatistics": utils, ...charts };
  const { AlbumStatisticsCard } = load("src/components/Settings/AlbumStatisticsCard.tsx", {
    "../../hooks/useAlbumStatistics": { useAlbumStatistics: () => query },
    "../../i18n": i18n,
    "../../i18n/albumStatistics": labelsModule,
    "../../utils/albumStatistics": utils,
    "./AlbumAccountBreakdown": load("src/components/Settings/AlbumAccountBreakdown.tsx", shared),
    "./AlbumStatisticsCharts": load("src/components/Settings/AlbumStatisticsCharts.tsx", shared),
    "./AlbumStatisticsSummary": load("src/components/Settings/AlbumStatisticsSummary.tsx", shared),
  });
  return AlbumStatisticsCard;
}

function render(query, accounts = [], locale) {
  const Card = loadCard(query, locale);
  return renderToStaticMarkup(React.createElement(Card, { accounts }));
}

const idleQuery = { isPending: false, isError: false, isFetching: false, refetch() {} };

test("card shows totals, coverage charts, unsynced hint, and per-account bars", () => {
  const html = render({ ...idleQuery, data: sampleStats }, [account("a", { userName: "Alice" })]);

  assert.match(html, /Album statistics/);
  assert.match(html, /1,200/);
  assert.match(html, /800/);
  assert.match(html, /60% of library/);
  assert.match(html, /40% of library/);
  assert.match(html, /2 shared/);
  assert.match(html, /1 album has not loaded/);
  assert.match(
    html,
    /aria-label="Library coverage: In an album 1,200 \(60%\), Not in an album 800 \(40%\)"/,
  );
  assert.match(
    html,
    /aria-label="Albums by account: Alice 4 \(80%\), Account no longer signed in 1 \(20%\)"/,
  );
  assert.match(html, /Alice: In an album: 1,000 · 66.7%, Not in an album: 500 · 33.3%/);
  assert.match(html, /1,500 photos/);
  assert.equal((html.match(/stroke-dasharray=/g) ?? []).length, 4, "two arcs per donut");
});

test("card shows loading, error, and empty states", () => {
  assert.match(
    render({ ...idleQuery, isPending: true, isFetching: true }),
    /Calculating album statistics/,
  );

  const error = render({ ...idleQuery, isError: true });
  assert.match(error, /role="alert"/);
  assert.match(error, /Could not calculate album statistics/);
  assert.match(error, />Retry</);
  assert.doesNotMatch(error, /Library coverage/);

  const empty = render({
    ...idleQuery,
    data: {
      albumCount: 0,
      sharedAlbumCount: 0,
      unsyncedAlbumCount: 0,
      assetsInAlbums: 0,
      assetsNotInAlbums: 0,
      accounts: [],
    },
  });
  assert.match(empty, /No albums or photos are cached yet/);
  assert.doesNotMatch(empty, /Library coverage/);
});

test("card renders French labels", () => {
  const html = render({ ...idleQuery, data: sampleStats }, [account("a")], "fr-CA");
  assert.match(html, /Statistiques des albums/);
  assert.match(html, /Dans aucun album/);
  assert.match(html, /Répartition par compte/);
});
