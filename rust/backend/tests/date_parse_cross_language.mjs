// Differential oracle for date_parse_cross_language.rs: reports V8's
// Date.parse for the JSON vector list the Rust test passes on argv[2], plus the
// host zone offset Node used at that instant (minutes, JS sign convention).
import process from "node:process";

const inputs = JSON.parse(process.argv[2]);
const results = inputs.map((input) => {
  const value = Date.parse(input);
  // VERIFY: wave17-date-4
  if (Number.isNaN(value)) {
    return { value: null, offsetMin: null };
  }
  return { value, offsetMin: new Date(value).getTimezoneOffset() };
});
process.stdout.write(JSON.stringify({ version: process.version, results }) + "\n");
