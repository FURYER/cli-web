/**
 * Patch @cursor/sdk so AskQuestion is not auto-rejected in local runs.
 * Re-run after every `npm install` (wired as postinstall).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

function resolveSdkRoot() {
  try {
    const pkg = require.resolve("@cursor/sdk/package.json");
    return dirname(pkg);
  } catch {
    return join(root, "node_modules", "@cursor", "sdk");
  }
}

const MARKER = "__cursorCliAskQuestion";
const REASON = "Interactive questions are not supported in local SDK runs";

/** @param {"cjs" | "esm"} kind */
function buildReplacement(kind) {
  const respond =
    kind === "cjs"
      ? (resultExpr) => `hr(e.id,${resultExpr})`
      : (resultExpr) => `u.x1.askQuestion(e.id,${resultExpr})`;
  const Result = kind === "cjs" ? "Xt.tz" : "w.tz";
  const Rejected = kind === "cjs" ? "Xt.ox" : "w.ox";

  const success = respond(
    `${Result}.fromJson({success:{answers:res.answers.map((a)=>({questionId:a.questionId,selectedOptionIds:a.selectedOptionIds||[],freeformText:a.freeformText||""}))}})`,
  );
  const rejected = (reasonExpr) =>
    respond(
      `new ${Result}({result:{case:"rejected",value:new ${Rejected}({reason:${reasonExpr}})}})`,
    );

  return (
    `case"askQuestionInteractionQuery":{` +
    `const ${MARKER}=globalThis.${MARKER};` +
    `if(typeof ${MARKER}==="function"){` +
    `const q=e.query.value;` +
    `const args=q&&q.args&&typeof q.args.toJson==="function"?q.args.toJson():q&&q.args||null;` +
    `const toolCallId=q&&(q.toolCallId||q.tool_call_id)||"";` +
    `return Promise.resolve(${MARKER}({id:e.id,toolCallId,args})).then((res)=>{` +
    `if(res&&res.outcome==="answered"&&Array.isArray(res.answers))return ${success};` +
    `return ${rejected(`(res&&res.reason)||"Questions skipped by the user"`)};` +
    `})}` +
    `return ${rejected(JSON.stringify(REASON))}` +
    `}`
  );
}

/**
 * @param {string} file
 * @param {"cjs" | "esm"} kind
 * @param {string} oldNeedle
 */
function patchFile(file, kind, oldNeedle) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    console.warn(`[patch-ask-question] skip missing ${file}`);
    return false;
  }

  if (source.includes(`${MARKER}=globalThis.${MARKER}`)) {
    console.info(`[patch-ask-question] already patched ${file}`);
    return true;
  }

  if (!source.includes(oldNeedle)) {
    console.warn(`[patch-ask-question] pattern not found in ${file}`);
    return false;
  }

  const next = source.replace(oldNeedle, buildReplacement(kind));
  if (next === source) {
    console.warn(`[patch-ask-question] replace failed for ${file}`);
    return false;
  }
  writeFileSync(file, next, "utf8");
  console.info(`[patch-ask-question] patched ${file}`);
  return true;
}

const sdkRoot = resolveSdkRoot();
const cjsNeedle =
  `case"askQuestionInteractionQuery":return hr(e.id,new Xt.tz({result:{case:"rejected",value:new Xt.ox({reason:"${REASON}"})}}));`;
const esmNeedle =
  `case"askQuestionInteractionQuery":return u.x1.askQuestion(e.id,new w.tz({result:{case:"rejected",value:new w.ox({reason:"${REASON}"})}}));`;

const okCjs = patchFile(join(sdkRoot, "dist", "cjs", "973.js"), "cjs", cjsNeedle);
const okEsm = patchFile(join(sdkRoot, "dist", "esm", "357.js"), "esm", esmNeedle);

if (!okCjs && !okEsm) {
  console.error("[patch-ask-question] failed to patch any SDK build");
  process.exitCode = 1;
}
