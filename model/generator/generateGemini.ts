import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const JIRA_BASE_URL   = process.env.JIRA_BASE_URL!;
const JIRA_EMAIL      = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN  = process.env.JIRA_API_TOKEN!;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY!;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Types ──────────────────────────────────────────────────────────────────

interface JiraStory {
  id: string;
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  testType: string;
  testPriority: string;
  framework: string;
}

interface GeneratedFiles {
  pageObject: string;
  testSpec: string;
  pageObjectName: string;
  specFileName: string;
}

// ─── Step 1: Fetch story from Jira ──────────────────────────────────────────

async function fetchJiraStory(storyKey: string): Promise<JiraStory> {
  console.log(`\n📥  Fetching Jira story: ${storyKey}`);

  const url  = `${JIRA_BASE_URL}/rest/api/3/issue/${storyKey}`;
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });

  const fields = response.data.fields;
  const description        = extractTextFromADF(fields.description);
  const acceptanceCriteria = extractAcceptanceCriteria(description);

  const testType     = fields["customfield_10100"]?.value ?? "E2E";
  const testPriority = fields["customfield_10101"]?.value ?? "Medium";
  const framework    = fields["customfield_10102"]?.value ?? "Playwright";

  console.log(`✅  Fetched: "${fields.summary}"`);
  console.log(`   Type: ${testType} | Priority: ${testPriority} | Framework: ${framework}`);

  return {
    id: response.data.id,
    key: response.data.key,
    summary: fields.summary,
    description,
    acceptanceCriteria,
    testType,
    testPriority,
    framework,
  };
}

// ─── Step 2: Parse Jira ADF to plain text ───────────────────────────────────

function extractTextFromADF(adf: any): string {
  if (!adf || !adf.content) return "";
  const lines: string[] = [];

  function walk(node: any) {
    if (!node) return;
    if (node.type === "text") {
      lines.push(node.text ?? "");
    } else if (node.type === "hardBreak" || node.type === "paragraph") {
      if (node.content) node.content.forEach(walk);
      lines.push("\n");
    } else if (node.type === "heading") {
      lines.push("\n## ");
      if (node.content) node.content.forEach(walk);
      lines.push("\n");
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      if (node.content) node.content.forEach(walk);
    } else if (node.type === "listItem") {
      lines.push("- ");
      if (node.content) node.content.forEach(walk);
    } else {
      if (node.content) node.content.forEach(walk);
    }
  }

  adf.content.forEach(walk);
  return lines.join("").trim();
}

function extractAcceptanceCriteria(description: string): string {
  const lower   = description.toLowerCase();
  const markers = ["acceptance criteria", "given", "scenario", "ac:"];
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) return description.slice(idx).trim();
  }
  return description;
}

// ─── Step 3: Derive PascalCase page name ────────────────────────────────────

function derivePageName(storyKey: string, summary: string): string {
  const stopWords = ["a","an","the","as","i","want","to","so","that",
                     "can","with","my","and","or","user","should","is","be"];
  
  const words = summary
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.includes(w.toLowerCase()))
    .slice(0, 3);

  const baseName = words
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");

  const finalBase = baseName || "Page";
  const cleanKey = storyKey.replace(/[^a-zA-Z0-9]/g, "");

  return `${finalBase}_${cleanKey}`;
}

// ─── Step 4: Call Gemini API ─────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  console.log(`✨  Calling Gemini (${GEMINI_MODEL})...`);

  const response = await axios.post(
    GEMINI_URL,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    },
    { timeout: 60_000 }
  );

  const candidate = response.data.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidates.");
  if (candidate.finishReason === "SAFETY") throw new Error("Gemini blocked response for safety.");

  return candidate.content?.parts?.[0]?.text ?? "";
}

// ─── Step 5: Generate tests via Gemini ──────────────────────────────────────

async function generateTests(story: JiraStory): Promise<GeneratedFiles> {
  const pageName = derivePageName(story.key, story.summary);

  const prompt = `You are a senior QA automation engineer specialising in Playwright TypeScript.

Generate two TypeScript files for the following Jira user story.

STORY KEY: ${story.key}
SUMMARY: ${story.summary}
TEST TYPE: ${story.testType}
PRIORITY: ${story.testPriority}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria}

RULES:
- Use Page Object Model (POM) architecture
- Export class named ${pageName}Page
- import { ${pageName}Page } from '../pages/${pageName}Page' inside your test spec file.
- Selector priority: page.locator() first, then data-testid
- One describe() block per file, one test() per Scenario
- Page Object constructor receives a Playwright Page object
- All methods async, return Promise<void>
- Strict TypeScript — no "any"

Return ONLY a JSON object with this exact shape:
{
  "pageObject": "<full TypeScript content>",
  "testSpec": "<full TypeScript content>"
}`;

  const raw = await callGemini(prompt);

  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```typescript/gi, "")
    .replace(/```/g, "")
    .trim();

  let parsed: { pageObject: string; testSpec: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Gemini did not return valid JSON.");
    parsed = JSON.parse(jsonMatch[0]);
  }

  if (!parsed.pageObject || !parsed.testSpec) {
    throw new Error("Missing pageObject or testSpec in response.");
  }

  return {
    pageObject: parsed.pageObject,
    testSpec: parsed.testSpec,
    pageObjectName: `${pageName}Page`,
    specFileName: `${pageName.toLowerCase()}.spec.ts`,
  };
}

// ─── Step 6: Write files to disk ────────────────────────────────────────────

function writeFiles(files: GeneratedFiles): void {
  const pagesDir = path.resolve("pages");
  const testsDir = path.resolve("tests");

  if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
  if (!fs.existsSync(testsDir)) fs.mkdirSync(testsDir, { recursive: true });

  const pageObjectPath = path.join(pagesDir, `${files.pageObjectName}.ts`);
  const testSpecPath   = path.join(testsDir, files.specFileName);

  fs.writeFileSync(pageObjectPath, files.pageObject, "utf8");
  fs.writeFileSync(testSpecPath,   files.testSpec,   "utf8");

  console.log(`📁  Files written:`);
  console.log(`   ${pageObjectPath}`);
  console.log(`   ${testSpecPath}`);
}

function validateGeneratedFiles(files: GeneratedFiles): void {
  const pageObjectPath = path.resolve("pages", `${files.pageObjectName}.ts`);
  const testSpecPath   = path.resolve("tests", files.specFileName);
  const tempConfigPath = path.resolve(".tmp-ts-validate.json");

  const tempConfig = {
    extends: "./tsconfig.json",
    compilerOptions: { ignoreDeprecations: "6.0" },
    include: [pageObjectPath, testSpecPath],
  };

  fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig, null, 2), "utf8");

  try {
    execSync(`npx tsc --noEmit --project "${tempConfigPath}"`, { stdio: "ignore" });
    console.log(`✅  TypeScript validation passed.`);
  } catch {
    console.warn(`⚠️  TypeScript syntax warnings found. Review code output manually.`);
  } finally {
    if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
  }
}

// ─── Main Execution supporting Loops ─────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const storyFlagIndex = args.indexOf("--story");

  if (storyFlagIndex === -1 || !args[storyFlagIndex + 1]) {
    console.error("❌  Usage: npx ts-node scripts/generate.ts --story <KEY1> <KEY2> ...");
    process.exit(1);
  }

  // Captures ALL keys after --story until another flag or end of array
  const storyKeys: string[] = [];
  for (let i = storyFlagIndex + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    storyKeys.push(args[i].toUpperCase());
  }

  const required = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "GEMINI_API_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  // Loop through every single story sequentially
  for (const storyKey of storyKeys) {
    try {
      console.log(`\n🚀 Processing story: ${storyKey}`);
      const story = await fetchJiraStory(storyKey);
      const files = await generateTests(story);
      writeFiles(files);
      validateGeneratedFiles(files);
      console.log(`✨ Completed sequence for ${storyKey}\n`);
    } catch (err: any) {
      console.error(`❌  Failed processing ${storyKey}:`, err.message ?? err);
    }
  }
}

main();