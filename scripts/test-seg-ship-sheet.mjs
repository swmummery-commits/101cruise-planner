import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildSheetCsvUrls,
  parseCsv,
  extractSegShipRows,
  dedupeSegSourceRows
} = require("../netlify/functions/lib/seg-ship-sheet.js");

const quoted = parseCsv('Cruise Line,Ship Name,Ship ID\n"Line, With Comma","Ship ""Quoted""",2500\n');
assert.equal(quoted[1][0], "Line, With Comma");
assert.equal(quoted[1][1], 'Ship "Quoted"');
assert.equal(quoted[1][2], "2500");

const extracted = extractSegShipRows(
  'SEG Ship Table\nCruise Line,Ship Name,Ship ID\nCelebrity Cruises,Celebrity Equinox,2500\nPrincess Cruises,Discovery Princess,3100\n'
);
assert.equal(extracted.headerRowNumber, 2);
assert.deepEqual(extracted.rows[0], {
  segShipId: "2500",
  shipName: "Celebrity Equinox",
  cruiseLine: "Celebrity Cruises",
  sourceRowNumber: 3
});
assert.equal(extracted.rows.length, 2);

const alternate = extractSegShipRows('ShipID,Ship,Cruise Line Name\n2500,Celebrity Equinox,Celebrity Cruises\n');
assert.equal(alternate.rows[0].segShipId, "2500");
assert.equal(alternate.rows[0].shipName, "Celebrity Equinox");

const deduped = dedupeSegSourceRows([
  { segShipId: "2500", shipName: "Celebrity Equinox", cruiseLine: "Celebrity Cruises", sourceRowNumber: 2 },
  { segShipId: "2500", shipName: "Celebrity Equinox", cruiseLine: "Celebrity Cruises", sourceRowNumber: 3 },
  { segShipId: "3000", shipName: "Ship One", cruiseLine: "Line A", sourceRowNumber: 4 },
  { segShipId: "3000", shipName: "Ship Two", cruiseLine: "Line B", sourceRowNumber: 5 }
]);
assert.equal(deduped.rows.length, 1);
assert.equal(deduped.duplicateRows.length, 1);
assert.equal(deduped.conflicts.length, 1);

const urls = buildSheetCsvUrls();
assert.equal(urls.length, 2);
assert.ok(urls[0].includes("export?format=csv"));
assert.ok(urls[1].includes("gviz/tq?tqx=out:csv"));

console.log("SEG ship sheet parser tests: PASS");
