<#
  One-shot push of this local repo to GitHub.
  The token is used only for this push; it is never written to .git/config.

  Usage:
    $env:GITHUB_TOKEN = 'github_pat_xxx'
    .\push-to-github.ps1 -RepoUrl 'https://github.com/<user>/tray-metrics.git'

  Or:
    .\push-to-github.ps1 -RepoUrl 'https://github.com/<user>/tray-metrics.git' -Token 'github_pat_xxx'

  Token: GitHub > Settings > Developer settings > Personal access tokens
         > Fine-grained tokens, scope it to this repo with Contents: Read & Write.
  When creating the remote repo, do NOT check "Add a README / .gitignore"
  (the local repo already has both) to avoid a first-push conflict.
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw 'Missing token: set $env:GITHUB_TOKEN or pass -Token.'
}

# Strip any credentials from a pasted URL so they never land in .git/config
$RepoUrl = ($RepoUrl.Trim() -replace '^https?://[^@/]+@', 'https://')
if ($RepoUrl -notmatch '^https://github\.com/[^/]+/[^/]+(\.git)?/?$') {
  throw "Invalid repo URL, expected https://github.com/<user>/<repo>.git (got: $RepoUrl)"
}
$RepoUrl = $RepoUrl.TrimEnd('/')
if (-not $RepoUrl.EndsWith('.git')) { $RepoUrl += '.git' }

git rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Current directory is not a git repository.' }

# Fill the real owner/repo into the GitHub Pages landing page, then commit it
$m = [regex]::Match($RepoUrl, 'github\.com/([^/]+)/([^/]+?)(?:\.git)?$')
if ($m.Success) {
  $ownerRepo = $m.Groups[1].Value + '/' + $m.Groups[2].Value
  $index = Join-Path $PSScriptRoot 'docs\index.html'
  if (Test-Path $index) {
    $text = [IO.File]::ReadAllText($index)
    $filled = $text.Replace('OWNER/REPO', $ownerRepo)
    if ($filled -ne $text) {
      [IO.File]::WriteAllText($index, $filled, (New-Object Text.UTF8Encoding($false)))
      git add docs/index.html | Out-Null
      git commit -m 'Set GitHub repo links in landing page' | Out-Null
      Write-Host "Landing page links set to: $ownerRepo"
    }
  }
}

git branch -M $Branch
$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $existing) {
  git remote set-url origin $RepoUrl
} else {
  git remote add origin $RepoUrl
}

# One-time HTTP header keeps the token out of disk and out of process arguments shown in logs
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
git -c credential.helper= -c "http.extraheader=AUTHORIZATION: basic $basic" push -u origin "${Branch}:${Branch}"
if ($LASTEXITCODE -ne 0) {
  throw 'Push failed. If the remote already has a README/initial commit, run: git pull --rebase origin main --allow-unrelated-histories'
}

$webUrl = $RepoUrl -replace '\.git$', ''
$pagesUrl = $webUrl -replace 'https://github\.com/([^/]+)/(.+)$', 'https://$1.github.io/$2/'
Write-Host "Pushed to: $webUrl"
Write-Host "Enable Pages (main /docs) then visit: $pagesUrl"
Write-Host "To publish the exe: git tag v1.0.0; git push origin v1.0.0 (triggers the GitHub Actions build + Release assets)"
