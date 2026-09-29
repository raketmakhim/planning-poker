param(
    [switch]$AutoApprove
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$infra = "$root\infra"

function Ensure-FromExample($path, $examplePath) {
    if (-not (Test-Path $path)) {
        Copy-Item $examplePath $path
        Write-Host "Created $path from $(Split-Path $examplePath -Leaf) - fill in the <REPLACE_ME> values before continuing."
    }
    if ((Get-Content $path -Raw) -match "<REPLACE_ME>") {
        throw "$path still has <REPLACE_ME> placeholders. Edit it and re-run."
    }
}

Ensure-FromExample "$infra\backend.hcl" "$infra\backend.hcl.example"
Ensure-FromExample "$infra\terraform.tfvars" "$infra\terraform.tfvars.example"

Push-Location $infra
try {
    if (-not (Test-Path "$infra\.terraform")) {
        Write-Host "Running terraform init..."
        terraform init -backend-config=backend.hcl
        if (-not $?) { throw "terraform init failed" }
    }

    Write-Host "Checking for infra changes..."
    terraform plan -detailed-exitcode -out=tfplan
    $planExitCode = $LASTEXITCODE

    if ($planExitCode -eq 1) {
        throw "terraform plan failed"
    } elseif ($planExitCode -eq 2) {
        if (-not $AutoApprove) {
            $confirm = Read-Host "Apply the plan above? (y/N)"
            if ($confirm -ne "y") { throw "Aborted by user" }
        }
        Write-Host "Applying infra changes..."
        terraform apply tfplan
        if (-not $?) { throw "terraform apply failed" }
    } else {
        Write-Host "No infra changes."
    }
    Remove-Item tfplan -ErrorAction SilentlyContinue

    $bucket = terraform output -raw frontend_bucket
    $distributionId = terraform output -raw distribution_id
    $url = terraform output -raw frontend_url
    $functionUrl = (terraform output -raw function_url).TrimEnd('/')
} finally {
    Pop-Location
}

# Derived from the infra output above, not a manual placeholder - always kept in sync.
Set-Content "$root\frontend\.env" "VITE_API_URL=$functionUrl" -NoNewline

function Get-FrontendHash {
    $files = @()
    $files += Get-ChildItem "$root\frontend\src" -Recurse -File
    if (Test-Path "$root\frontend\public") {
        $files += Get-ChildItem "$root\frontend\public" -Recurse -File
    }
    $files += Get-Item "$root\frontend\index.html", "$root\frontend\package.json", "$root\frontend\package-lock.json", "$root\frontend\vite.config.js", "$root\frontend\.env"

    $combined = ($files | Sort-Object FullName | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ""
    $stream = [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes($combined))
    return (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
}

$hashFile = "$root\.frontend-deploy-hash"
$currentHash = Get-FrontendHash
$previousHash = if (Test-Path $hashFile) { Get-Content $hashFile -Raw } else { "" }

if ($currentHash -eq $previousHash) {
    Write-Host "No frontend changes, skipping build/deploy."
} else {
    Write-Host "Building frontend..."
    Push-Location "$root\frontend"
    try {
        npm run build
        if (-not $?) { throw "npm build failed" }
    } finally {
        Pop-Location
    }

    Write-Host "Syncing dist/ to s3://$bucket ..."
    aws s3 sync "$root\frontend\dist" "s3://$bucket" --delete
    if (-not $?) { throw "s3 sync failed" }

    Write-Host "Invalidating CloudFront cache..."
    aws cloudfront create-invalidation --distribution-id $distributionId --paths "/*" | Out-Null

    Set-Content $hashFile $currentHash -NoNewline
}

Write-Host "Deployed: $url"
