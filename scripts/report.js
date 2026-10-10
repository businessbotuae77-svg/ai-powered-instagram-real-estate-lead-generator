// Prints the daily outcome report from the runtime files.
//   node scripts/report.js [YYYY-MM-DD]   (default: yesterday in Dubai)
import { loadEnv } from "./load-env.js";
import { runtimeRoot } from "../src/integrations/json-store.js";
import { buildDailyReport, formatDailyReport, loadReportInputs, yesterdayInDubai } from "../src/reporting/outcome-report.js";

loadEnv();
const day = process.argv[2] || yesterdayInDubai();
const inputs = await loadReportInputs(process.env.RUNTIME_DATA_DIR || runtimeRoot());
console.log(formatDailyReport(buildDailyReport({ ...inputs, day })));
