#!/usr/bin/env node

/**
 * scripts/gemini-runner.mjs — Native Gemini runner for Career Ops
 * 
 * Provides direct Gemini API token evaluation without requiring an external
 * CLI tool. Acts as a drop-in runner for `gemini -p <prompt>`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// 1. Load .env
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || "";
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ Error: GEMINI_API_KEY is not set in .env. Please configure it in .env first.");
  process.exit(1);
}

// 2. Parse arguments: find `-p` or `--prompt`
const args = process.argv.slice(2);
let prompt = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-p" || args[i] === "--prompt") {
    prompt = args[i + 1] || "";
    i++;
  } else if (!prompt && !args[i].startsWith("-")) {
    prompt = args[i];
  }
}

if (!prompt && !process.stdin.isTTY) {
  try {
    prompt = fs.readFileSync(0, "utf8");
  } catch {
    // ignore
  }
}

if (!prompt) {
  console.error("Usage: gemini -p <prompt>");
  process.exit(1);
}

// 3. Helper to read safe context files
function readSafe(filePath) {
  try {
    const full = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8").trim() : "";
  } catch {
    return "";
  }
}

// 4. Extract URL if present
function extractUrl(text) {
  const jsonMatch = text.match(/"url"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/);
  return urlMatch ? urlMatch[0] : null;
}

// 5. Fetch JD text if URL is present
async function fetchJd(url) {
  if (!url) return null;
  // Try fetch-jd.mjs first
  const fetchJdScript = path.join(ROOT, "fetch-jd.mjs");
  if (fs.existsSync(fetchJdScript)) {
    try {
      const out = execFileSync(process.execPath, [fetchJdScript, url], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out && out.trim() && !out.startsWith("CLOSED_POSTING")) {
        return out.trim();
      }
    } catch {
      // fallback
    }
  }

  // Fallback to direct HTTP fetch
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (res.ok) {
      const html = await res.text();
      // Simple HTML-to-text conversion
      const text = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s{2,}/g, " ")
        .trim();
      return text.slice(0, 15000);
    }
  } catch {
    // ignore
  }
  return null;
}

// 6. Gemini API call with fallback models
const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-3.8-flash",
];

const genAI = new GoogleGenerativeAI(apiKey);

async function generateWithFallback(systemInstruction, userContent) {
  let lastErr = null;
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction || undefined,
      });
      const result = await model.generateContentStream(userContent);
      return { result, modelName };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (msg.includes("503") || msg.includes("429") || msg.includes("not found")) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function main() {
  const isEvaluate = prompt.includes("career-ops job evaluation") || prompt.includes("modes/oferta.md") || prompt.includes("<<report-md>>");
  const jobUrl = extractUrl(prompt);

  let systemInstruction = "";
  let userTurn = prompt;

  if (isEvaluate) {
    let jdText = await fetchJd(jobUrl);
    if (!jdText) {
      // Check if prompt has prefetched JD
      const jdMatch = prompt.match(/PREFETCHED JOB DESCRIPTION:\s*([\s\S]+?)(?=\n\n(?:[A-Z\s]+:|\n|$))/);
      jdText = jdMatch ? jdMatch[1] : (jobUrl ? `Job posting at ${jobUrl}` : prompt);
    }

    const cv = readSafe("cv.md");
    const profile = readSafe("modes/_profile.md");
    const profileYml = readSafe("config/profile.yml");
    const shared = readSafe("modes/_shared.md");
    const oferta = readSafe("modes/oferta.md");

    systemInstruction = `You are career-ops, an expert AI job search evaluation assistant.
You evaluate job offers against the candidate's CV and profile using the structured A-G scoring rubric in modes/oferta.md.

CANDIDATE CV (cv.md):
${cv}

CANDIDATE PROFILE (config/profile.yml):
${profileYml}

ARCHETYPES & GOALS (modes/_profile.md):
${profile}

EVALUATION RUBRIC & INSTRUCTIONS:
${oferta}
${shared}

OUTPUT FORMAT REQUIREMENTS:
1. You MUST enclose the entire evaluation report inside <<report-md>> and <</report-md>> tags.
2. The report MUST start with:
   # Evaluation: <Company Name> — <Job Title>
3. The report MUST include full sections for:
   - Block A: Overall Match & Seniority Fit
   - Block B: Tech Stack Fit & Competencies
   - Block C: Experience & Domain Relevance
   - Block D: Education & Requirements Check
   - Block E: Key Strengths & Gaps
   - Block F: Strategic Recommendations
   - Block G: Legitimacy & Posting Integrity
4. The report MUST end with the canonical Machine Summary section:
   ## Machine Summary

   \`\`\`yaml
   company: "<Company Name>"
   role: "<Job Title>"
   score: <Overall decimal score, e.g. 4.2>
   via: "${jobUrl || "https://example.com"}"
   archetype: "<Best matching archetype>"
   legitimacy: "High Confidence"
   \`\`\`
5. AFTER the <</report-md>> tag, output EXACTLY ONE FINAL LINE:
   VERDICT: <Score>/5 — <Reason in 12 words or fewer>
`;

    userTurn = `Evaluate this job posting against Rohit Ghosh's profile and CV:
Target URL: ${jobUrl || "Direct Job Input"}

JOB DESCRIPTION:
${jdText}
`;
  }

  try {
    const { result } = await generateWithFallback(systemInstruction, userTurn);
    for await (const chunk of result.stream) {
      const text = chunk.text();
      process.stdout.write(text);
    }
  } catch (err) {
    console.error("Gemini Runner Error:", err?.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
