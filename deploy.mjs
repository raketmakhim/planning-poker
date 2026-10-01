import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const root = dirname(fileURLToPath(import.meta.url));
const infra = join(root, "infra");
const frontend = join(root, "frontend");
const autoApprove = process.argv.includes("--auto-approve");

function run(cmd, args, cwd) {
  // npm needs a shell on Windows (it's a .cmd, not a real exe); folding args into one string
  // avoids Node's shell+array escaping warning, safe since these args are always fixed tokens.
  const needsShell = process.platform === "win32" && cmd === "npm";
  const res = needsShell
    ? spawnSync(`${cmd} ${args.join(" ")}`, { cwd, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.error) throw new Error(`${cmd} ${args.join(" ")} failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  return res.status;
}

function output(name) {
  return execFileSync("terraform", ["output", "-raw", name], { cwd: infra }).toString().trim();
}

function ensureFromExample(path, examplePath) {
  if (!existsSync(path)) {
    copyFileSync(examplePath, path);
    console.log(`Created ${path} from ${examplePath} - fill in the <REPLACE_ME> values before continuing.`);
  }
  if (readFileSync(path, "utf8").includes("<REPLACE_ME>")) {
    throw new Error(`${path} still has <REPLACE_ME> placeholders. Edit it and re-run.`);
  }
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkFiles(p) : [p];
  });
}

function getFrontendHash() {
  const files = [
    ...walkFiles(join(frontend, "src")),
    ...walkFiles(join(frontend, "public")),
    join(frontend, "index.html"),
    join(frontend, "package.json"),
    join(frontend, "package-lock.json"),
    join(frontend, "vite.config.js"),
    join(frontend, ".env"),
  ].filter(existsSync).sort();

  const combined = files.map((f) => createHash("sha256").update(readFileSync(f)).digest("hex")).join("");
  return createHash("sha256").update(combined).digest("hex");
}

async function main() {
  ensureFromExample(join(infra, "backend.hcl"), join(infra, "backend.hcl.example"));
  ensureFromExample(join(infra, "terraform.tfvars"), join(infra, "terraform.tfvars.example"));

  if (!existsSync(join(infra, ".terraform"))) {
    console.log("Running terraform init...");
    run("terraform", ["init", "-backend-config=backend.hcl"], infra);
  }

  console.log("Checking for infra changes...");
  const planStatus = spawnSync("terraform", ["plan", "-detailed-exitcode", "-out=tfplan"], {
    cwd: infra,
    stdio: "inherit",
  }).status;

  if (planStatus === 1) {
    throw new Error("terraform plan failed");
  } else if (planStatus === 2) {
    if (!autoApprove) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Apply the plan above? (y/N) ");
      rl.close();
      if (answer.toLowerCase() !== "y") throw new Error("Aborted by user");
    }
    console.log("Applying infra changes...");
    run("terraform", ["apply", "tfplan"], infra);
  } else {
    console.log("No infra changes.");
  }
  const tfplanPath = join(infra, "tfplan");
  if (existsSync(tfplanPath)) unlinkSync(tfplanPath);

  const bucket = output("frontend_bucket");
  const distributionId = output("distribution_id");
  const url = output("frontend_url");
  const functionUrl = output("function_url").replace(/\/$/, "");

  // Derived from the infra output above, not a manual placeholder - always kept in sync.
  writeFileSync(join(frontend, ".env"), `VITE_API_URL=${functionUrl}`);

  const hashFile = join(root, ".frontend-deploy-hash");
  const currentHash = getFrontendHash();
  const previousHash = existsSync(hashFile) ? readFileSync(hashFile, "utf8") : "";

  if (currentHash === previousHash) {
    console.log("No frontend changes, skipping build/deploy.");
  } else {
    console.log("Building frontend...");
    run("npm", ["run", "build"], frontend);

    console.log(`Syncing dist/ to s3://${bucket} ...`);
    run("aws", ["s3", "sync", join(frontend, "dist"), `s3://${bucket}`, "--delete"], root);

    console.log("Invalidating CloudFront cache...");
    run("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*"], root);

    writeFileSync(hashFile, currentHash);
  }

  console.log(`Deployed: ${url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
