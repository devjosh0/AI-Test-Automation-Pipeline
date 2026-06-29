import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { execSync } from "child_process";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const JIRA_BASE_URL  = process.env.JIRA_BASE_URL!;
const JIRA_EMAIL     = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    ?? "codellama";

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

// ─── Step 1: Verify Ollama is running ───────────────────────────────────────

async function checkOllama(): Promise<void> {
  console.log(`\n🔍  Checking Ollama at ${OLLAMA_BASE_URL}...`);
  try {
    await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 3000 });
    console.log(`✅  Ollama is running (model: ${OLLAMA_MODEL})`);
  } catch {
    console.error(`❌  Cannot reach Ollama at ${OLLAMA_BASE_URL}`);
    console.error(`    Make sure Ollama is running: ollama serve`);
    console.error(`    And your model is pulled:    ollama pull ${OLLAMA_MODEL}`);
    process.exit(1);
  }
}

// ─── Step 2: Fetch story from Jira ──────────────────────────────────────────

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

// ─── Step 3: Parse Jira ADF to plain text ───────────────────────────────────

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

// ─── Step 4: Derive PascalCase page name ────────────────────────────────────

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
  const cleanKey  = storyKey.replace(/[^a-zA-Z0-9]/g, "");
  return `${finalBase}_${cleanKey}`;
}

// ─── Step 5: Call Ollama ─────────────────────────────────────────────────────

async function callOllama(prompt: string): Promise<string> {
  console.log(`\n🦙  Calling Ollama (model: ${OLLAMA_MODEL})...`);
  console.log(`    This may take 30–90 seconds on first run.\n`);

  const response = await axios.post(
    `${OLLAMA_BASE_URL}/api/generate`,
    {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: 4096,
      },
    },
    { timeout: 120_000 }
  );

  return response.data.response as string;
}

// ─── Step 6: Generate tests via Ollama ──────────────────────────────────────

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
- Import { ${pageName}Page } from '../pages/${pageName}Page' inside your test spec file
- Selector priority: page.locator() first, then data-testid
- One describe() block per file, one test() per Scenario
- Page Object constructor receives a Playwright Page object
- All methods async, return Promise<void>
- Strict TypeScript — no "any"
- Output ONLY raw JSON — no markdown, no explanation, no code fences

Return ONLY this JSON (no markdown fences, no extra text):
{
  "pageObject": "<full TypeScript content of pages/${pageName}Page.ts>",
  "testSpec": "<full TypeScript content of tests/${pageName.toLowerCase()}.spec.ts>"
}

JSON output:`;

  const raw = await callOllama(prompt);

  // Strip markdown fences that some models add
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
    if (!jsonMatch) {
      console.error("\n❌  Ollama did not return valid JSON. Raw output:\n");
      console.error(raw.slice(0, 800));
      console.error("\n💡  Try a better model:");
      console.error("    ollama pull deepseek-coder-v2");
      console.error("    Then set OLLAMA_MODEL=deepseek-coder-v2 in your .env");
      process.exit(1);
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("\n❌  JSON parse failed. Raw match:\n", jsonMatch[0].slice(0, 500));
      process.exit(1);
    }
  }

  if (!parsed.pageObject || !parsed.testSpec) {
    throw new Error("Missing pageObject or testSpec in Ollama response.");
  }

  console.log(`✅  Ollama generated files for ${pageName}Page`);

  return {
    pageObject: parsed.pageObject,
    testSpec: parsed.testSpec,
    pageObjectName: `${pageName}Page`,
    specFileName: `${pageName.toLowerCase()}.spec.ts`,
  };
}

// ─── Step 7: Write files to disk ────────────────────────────────────────────

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

// ─── Step 8: Validate TypeScript ────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args           = process.argv.slice(2);
  const storyFlagIndex = args.indexOf("--story");

  if (storyFlagIndex === -1 || !args[storyFlagIndex + 1]) {
    console.error("❌  Usage: npx ts-node scripts/generate.ts --story <KEY1> <KEY2> ...");
    process.exit(1);
  }

  // Capture ALL keys after --story until another flag or end
  const storyKeys: string[] = [];
  for (let i = storyFlagIndex + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    storyKeys.push(args[i].toUpperCase());
  }

  const required = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`❌  Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  await checkOllama();

  for (const storyKey of storyKeys) {
    try {
      console.log(`\n🚀  Processing story: ${storyKey}`);
      const story = await fetchJiraStory(storyKey);
      const files  = await generateTests(story);
      writeFiles(files);
      validateGeneratedFiles(files);
      console.log(`✨  Completed: ${storyKey}\n`);
    } catch (err: any) {
      console.error(`❌  Failed processing ${storyKey}:`, err.message ?? err);
    }
  }
}

main();