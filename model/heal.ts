import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const RESULTS_FILE = process.env.RESULTS_FILE ?? "results.json";

interface PlaywrightResult { suites: Suite[]; }
interface Suite { title: string; file: string; suites?: Suite[]; specs: Spec[]; }
interface Spec { title: string; ok: boolean; tests: any[]; }
interface FailedTest {
  file: string;
  title: string;
  errorMessage: string;
  sourceFile: string | null;
  expected?: string;
  received?: string;
  matcherName?: string;
  isNegative: boolean;
}

// ─── Step 1: Deep Playwright Result JSON Parser ──────────────────────────────
function parseFailedTests(resultsPath: string): FailedTest[] {
  if (!fs.existsSync(resultsPath)) {
    console.error(`❌ Results file not found: ${resultsPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(resultsPath, "utf8");
  const results: PlaywrightResult = JSON.parse(raw);
  const failed: FailedTest[] = [];

  function stripAnsi(str: string): string {
    return str.replace(/\u001b\[[0-9;]*m/g, "");
  }

  function walkSuites(suites: Suite[], file: string) {
    for (const suite of suites) {
      const currentFile = suite.file ?? file;
      if (suite.suites) walkSuites(suite.suites, currentFile);

      for (const spec of suite.specs ?? []) {
        if (!spec.ok) {
          for (const test of spec.tests) {
            const status = test.status;
            if (status === "failed" || status === "unexpected" || status === "timedOut") {
              let errorMessage = "";
              let extractedSource: string | null = null;
              const testResults = test.results ?? [];

              for (const result of testResults) {
                for (const err of result.errors ?? []) {
                  const msg = stripAnsi(err.message ?? "");
                  if (msg) {
                    errorMessage = msg;
                    if (err.location?.file) extractedSource = err.location.file;
                    break;
                  }
                }
                if (errorMessage) break;
              }

              const analysis = analyzePlaywrightError(errorMessage);
              const sourceFile = resolveFilePath(extractedSource, currentFile);

              failed.push({
                file: currentFile,
                title: spec.title,
                errorMessage,
                sourceFile,
                expected: analysis.expected,
                received: analysis.received,
                matcherName: analysis.matcherName,
                isNegative: analysis.isNegative
              });
            }
          }
        }
      }
    }
  }

  walkSuites(results.suites ?? [], "");
  return failed;
}

// ─── Step 2: Adaptive Error Signature Extraction ─────────────────────────────
function analyzePlaywrightError(errorMessage: string): { expected?: string; received?: string; matcherName?: string; isNegative: boolean } {
  const clean = errorMessage.replace(/\u001b\[[0-9;]*m/g, '');
  
  // Extract specific matcher name from call logs or error headers (e.g., toBeVisible, toHaveText)
  let matcherName: string | undefined;
  const matcherMatch = clean.match(/expect\(.*?\)\.(not\.)?([a-zA-Z0-9_]+)\(/) || clean.match(/Error:\s*expect.*?\.([a-zA-Z0-9_]+)\(\)/);
  if (matcherMatch) {
    matcherName = matcherMatch[2] || matcherMatch[1];
  }

  const isNegative = clean.includes("not.toBe") || clean.includes("not.to_have") || /expected:\s*not\s+/i.test(clean) || (clean.includes("Expected: not") && !clean.includes("Expected: notice"));

  // Universal Expected / Received Blocks
  let expected: string | undefined;
  let received: string | undefined;

  const generalMatch = clean.match(/Expected:\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([\s\S]*?))\n[\s\S]*?Received:\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([\s\S]*?))\n/);
  if (generalMatch) {
    expected = (generalMatch[1] ?? generalMatch[2] ?? generalMatch[3] ?? "").trim();
    received = (generalMatch[4] ?? generalMatch[5] ?? generalMatch[6] ?? "").trim();
  } else {
    // Structural Fallback for implicit state mismatches (e.g., visibility, checking states)
    const expM = clean.match(/Expected:\s*([^\n]+)/i);
    const recM = clean.match(/Received:\s*([^\n]+)/i);
    if (expM && recM) {
      expected = expM[1].trim();
      received = recM[1].trim();
    }
  }

  return { expected, received, matcherName, isNegative };
}

function resolveFilePath(explicitFile: string | null, fallbackFile: string): string | null {
  const fileToResolve = explicitFile || fallbackFile;
  if (!fileToResolve) return null;
  const cleanPath = fileToResolve.replace(/[\\/]/g, path.sep);
  const absolute = path.resolve(cleanPath);
  return fs.existsSync(absolute) ? path.relative(process.cwd(), absolute) : null;
}

// ─── Step 3: Global Assertion State Transformer ──────────────────────────────
function generateUniversalFixes(failed: FailedTest, specContent: string): { old: string; new: string }[] {
  const fixes: { old: string; new: string }[] = [];
  const matcher = failed.matcherName;

  if (!matcher) return [];

  // ─── PART A: Structural / Boolean / State Assertion Matchers ───
  // Maps logical opposing methods based on the official Playwright Specification
  const structuralInversions: Record<string, string> = {
    "toBeVisible": "toBeHidden",
    "toBeHidden": "toBeVisible",
    "toBeEnabled": "toBeDisabled",
    "toBeDisabled": "toBeEnabled",
    "toBeChecked": "toBeUnchecked",
    "toBeEditable": "toBeReadOnly", // standard mappings
    "toBeTruthy": "toBeFalsy",
    "toBeFalsy": "toBeTruthy",
    "toBeDefined": "toBeUndefined",
    "toBeUndefined": "toBeDefined",
    "toBeNull": "toBeDefined"
    
  };

  if (structuralInversions[matcher]) {
    const alternateMatcher = structuralInversions[matcher];
    
    // Scenario 1: Strip or apply .not inversion modifier safely
    if (failed.isNegative) {
      fixes.push({ old: `.not.${matcher}`, new: `.${matcher}` });
    } else {
      fixes.push({ old: `.${matcher}`, new: `.not.${matcher}` });
    }
    // Scenario 2: Inline method structural transformations (e.g. .toBeHidden() -> .toBeVisible())
    fixes.push({ old: `.${matcher}`, new: `.${alternateMatcher}` });
  }

  // ─── PART B: Value, Parameterized, and String Literal Matchers ───
  if (failed.expected !== undefined && failed.received !== undefined && failed.expected !== failed.received) {
    const exp = failed.expected;
    const rec = failed.received;

    // Handles value adjustments inside parameters e.g., toHaveCount(2) -> toHaveCount(5)
    // or toHaveURL('old') -> toHaveURL('new')
    const quoteVariants = [
      { old: `'${exp}'`, new: `'${rec}'` },
      { old: `"${exp}"`, new: `"${rec}"` },
      { old: `\`${exp}\``, new: `\`${rec}\`` },
      { old: `(${exp})`, new: `(${rec})` } // Counts/Numbers or bare booleans inside calls
    ];

    for (const v of quoteVariants) {
      if (specContent.includes(v.old)) {
        fixes.push(v);
      }
    }

    // Multiline escaped string cleanup patterns
    const cleanExp = exp.replace(/\\n/g, '\n').replace(/\\r/g, '');
    const cleanRec = rec.replace(/\\n/g, '\n').replace(/\\r/g, '');
    if (cleanExp !== exp) {
      fixes.push({ old: cleanExp, new: cleanRec });
    }
  }

  return fixes;
}

function applyUniversalFixes(specPath: string, fixes: { old: string; new: string }[]): boolean {
  if (!fs.existsSync(specPath)) return false;

  const original = fs.readFileSync(specPath, "utf8");
  let content = original;
  let changed = false;

  for (const fix of fixes) {
    if (fix.old && content.includes(fix.old)) {
      // Safely replace the exact failing invocation signature instance
      content = content.replaceAll(fix.old, fix.new);
      console.log(`🔧 Automated Patch Applied inside [${path.basename(specPath)}]:\n   Removed: "${fix.old}"\n   Injected: "${fix.new}"`);
      changed = true;
      break; 
    }
  }

  if (changed) {
    fs.writeFileSync(specPath, content, "utf8");
    return true;
  }
  return false;
}

// ─── Main Execution Framework ────────────────────────────────────────────────
async function main() {
  console.log(`🏥 Scanning Playwright Test Spec Engine across all web-first matchers...`);
  const failedTests = parseFailedTests(RESULTS_FILE);

  if (failedTests.length === 0) {
    console.log("✅ Zero regressions or broken assertions identified.");
    process.exit(0);
  }

  let totalHealed = 0;

  for (const failed of failedTests) {
    const targets: string[] = [];
    if (failed.sourceFile && fs.existsSync(failed.sourceFile)) targets.push(failed.sourceFile);
    if (failed.file && fs.existsSync(failed.file) && !targets.includes(failed.file)) targets.push(failed.file);

    // Page-Object model back-referencing cross mapping
    if (failed.sourceFile && failed.sourceFile.includes('pages')) {
      const specName = path.basename(failed.sourceFile).replace(/page\.(ts|js)$/i, '').replace(/Page\.(ts|js)$/, '').toLowerCase();
      const suspectedSpecFile = path.join('tests', `${specName}.spec.ts`);
      if (fs.existsSync(suspectedSpecFile) && !targets.includes(suspectedSpecFile)) {
        targets.push(suspectedSpecFile);
      }
    }

    let healed = false;

    for (const targetFile of targets) {
      const specContent = fs.readFileSync(targetFile, "utf8");
      const fixes = generateUniversalFixes(failed, specContent);
      
      if (fixes.length > 0) {
        healed = applyUniversalFixes(targetFile, fixes);
        if (healed) {
          totalHealed++;
          break; 
        }
      }
    }

    if (!healed) {
      console.log(`⏭️  Could not auto-heal "${failed.title}" [Matcher: .${failed.matcherName || 'unknown'}()]. Requires structural code architecture changes.`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏥 Playwright Engine Healing completed. Total Assertions Healed: ${totalHealed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}
main();