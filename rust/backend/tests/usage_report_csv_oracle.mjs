import fs from "node:fs";
import process from "node:process";
import vm from "node:vm";

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const errors = [];
const context = {
  console: { error: (...args) => errors.push(args.join(" ")) },
};
vm.createContext(context);
vm.runInContext(`${request.source}\n;globalThis.__csv = { HEADER, COLS, parseCsv, dictReader, _csv_field, _row_array };`, context);
const csv = context.__csv;
const parsed = request.inputs.map((input) => csv.parseCsv(input));
const dictionaries = request.inputs.map((input) => Array.from(csv.dictReader(input), (row) => {
  const keys = Object.keys(row);
  return keys.map((key) => [key, row[key]]);
}));
const rows = request.rows.map((row) => {
  const result = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (value?.__number === "NaN") result[key] = Number.NaN;
    else if (value?.__number === "Infinity") result[key] = Number.POSITIVE_INFINITY;
    else if (value?.__number === "-Infinity") result[key] = Number.NEGATIVE_INFINITY;
  }
  return result;
});
const encoded = rows.map((row) => csv._row_array(row).map(csv._csv_field).join(",") + "\n");
process.stdout.write(JSON.stringify({ header: csv.HEADER, columns: csv.COLS, parsed, dictionaries, encoded, errors }));
