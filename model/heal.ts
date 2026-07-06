import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const RESULTS_FILE = process.env.RESULTS_FILE ?? "results.json";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.error("❌ Critical Error: GEMINI_API_KEY is missing from your environment setup.");
  process.exit(1);
}

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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
  
  let matcherName: string | undefined;
  const matcherMatch = clean.match(/expect\(.*?\)\.(not\.)?([a-zA-Z0-9_]+)\(/) || clean.match(/Error:\s*expect.*?\.([a-zA-Z0-9_]+)\(\)/);
  if (matcherMatch) {
    matcherName = matcherMatch[2] || matcherMatch[1];
  }

  const isNegative = clean.includes("not.toBe") || clean.includes("not.to_have") || /expected:\s*not\s+/i.test(clean) || (clean.includes("Expected: not") && !clean.includes("Expected: notice"));

  let expected: string | undefined;
  let received: string | undefined;

  const generalMatch = clean.match(/Expected:\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([\s\S]*?))\n[\s\S]*?Received:\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([\s\S]*?))\n/);
  if (generalMatch) {
    expected = (generalMatch[1] ?? generalMatch[2] ?? generalMatch[3] ?? "").trim();
    received = (generalMatch[4] ?? generalMatch[5] ?? generalMatch[6] ?? "").trim();
  } else {
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

// ─── Step 3: Gemini AI Assertion Fixing Engine ───────────────────────────────
async function generateAIFixes(failed: FailedTest, specContent: string): Promise<{ old: string; new: string }[]> {
  try {
    const prompt = `
      You are an expert QA automation engineer specialized in fixing broken Playwright tests.
      
      Test Title: "${failed.title}"
      Error Message Encountered: 
      """
      ${failed.errorMessage}
      """
      
      Target File Source Code Context:
      """
      ${specContent}
      """
      
      Analyze the error message relative to the source code context. Identify the exact line of code causing the mismatch failure. 
      Determine how the code must be modified (either updating values, parameters, or logical assertions) to heal the regression cleanly.
      
      Respond ONLY with a valid JSON object matching this structural schema:
      {
        "old": "exact string match to locate within the source code",
        "new": "exact replacement string patch to fix the assertion"
      }
    `;

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const errorResponse = await response.text();
      throw new Error(`Gemini service error [HTTP ${response.status}]: ${errorResponse}`);
    }

    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) return [];

    const fix = JSON.parse(resultText);
    return fix.old && fix.new ? [fix] : [];

  } catch (error) {
    console.error(`❌ AI Generation Failure:`, error);
    return [];
  }
}

function applyUniversalFixes(specPath: string, fixes: { old: string; new: string }[]): boolean {
  if (!fs.existsSync(specPath)) return false;

  const original = fs.readFileSync(specPath, "utf8");
  let content = original;
  let changed = false;

  for (const fix of fixes) {
    if (fix.old && content.includes(fix.old)) {
      content = content.replaceAll(fix.old, fix.new);
      console.log(`🔧 Gemini Patch Applied inside [${path.basename(specPath)}]:\n   Removed: "${fix.old}"\n   Injected: "${fix.new}"`);
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
  console.log(`🏥 Scanning Playwright Engine via ${GEMINI_MODEL} Context Streams...`);
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
      
      // Request clean code transformations directly from Gemini REST endpoint
      const fixes = await generateAIFixes(failed, specContent);
      
      if (fixes.length > 0) {
        healed = applyUniversalFixes(targetFile, fixes);
        if (healed) {
          totalHealed++;
          break; 
        }
      }
    }

    if (!healed) {
      console.log(`⏭️  Could not auto-heal "${failed.title}". Gemini structural mapping was rejected or unmatched.`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏥 Gemini Autonomous Playwright Repair Matrix Completed.`);
  console.log(`   Total Assertions Healed: ${totalHealed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main();