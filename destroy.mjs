import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const root = dirname(fileURLToPath(import.meta.url));
const infra = join(root, "infra");
const autoApprove = process.argv.includes("--auto-approve");

function run(cmd, args, cwd) {
  const resolvedCmd = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const res = spawnSync(resolvedCmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
  return res.status;
}

function tryOutput(name) {
  try {
    return execFileSync("terraform", ["output", "-raw", name], { cwd: infra }).toString().trim();
  } catch {
    return null;
  }
}

async function main() {
  if (!existsSync(join(infra, ".terraform"))) {
    console.log("Nothing to destroy: infra was never initialized here.");
    return;
  }

  // The frontend bucket has no force_destroy, so Terraform can't delete it while it holds objects.
  const bucket = tryOutput("frontend_bucket");
  if (bucket) {
    console.log(`Emptying s3://${bucket} ...`);
    run("aws", ["s3", "rm", `s3://${bucket}`, "--recursive"], root);
  }

  console.log("Planning destroy...");
  const planStatus = spawnSync(
    "terraform",
    ["plan", "-destroy", "-detailed-exitcode", "-out=tfdestroyplan"],
    { cwd: infra, stdio: "inherit" }
  ).status;

  if (planStatus === 1) {
    throw new Error("terraform plan -destroy failed");
  } else if (planStatus === 0) {
    console.log("Nothing to destroy. Infra is already empty.");
    return;
  }

  if (!autoApprove) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Destroy everything shown above? This cannot be undone. (y/N) ");
    rl.close();
    if (answer.toLowerCase() !== "y") throw new Error("Aborted by user");
  }

  console.log("Destroying infra...");
  run("terraform", ["apply", "tfdestroyplan"], infra);

  const tfdestroyplanPath = join(infra, "tfdestroyplan");
  if (existsSync(tfdestroyplanPath)) unlinkSync(tfdestroyplanPath);

  const hashFile = join(root, ".frontend-deploy-hash");
  if (existsSync(hashFile)) unlinkSync(hashFile);

  console.log("Destroyed.");
  console.log(
    "Note: the Terraform state bucket itself (created manually, outside Terraform) was not touched. " +
      "Delete it yourself if you want it gone too: aws s3 rb s3://<your-state-bucket> --force"
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
