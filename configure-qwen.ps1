param(
    [string]$ApiHost,
    [string]$Model = 'qwen3.5-omni-plus'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host 'Rushi - Qwen / Alibaba Cloud Bailian setup'
Write-Host 'Use API Host and API key from the SAME region/workspace.'
Write-Host ('Model: ' + $Model + '. Thinking disabled. No network call during setup.')
if (-not $ApiHost) { $ApiHost = Read-Host 'Paste API Host or compatible Base URL from Bailian (not the API key)' }
$address = $ApiHost.Trim().TrimEnd('/')
if (-not $address.Contains('://')) { $address = 'https://' + $address }
$endpoint = $null
if (-not [Uri]::TryCreate($address, [UriKind]::Absolute, [ref]$endpoint)) { throw 'Invalid API Host. Copy it from the Bailian workspace/API key screen.' }
if ($endpoint.Scheme -ne 'https' -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) { throw 'Qwen requires an HTTPS API Host without credentials, query or fragment.' }
$knownLegacy = @('dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'cn-hongkong.dashscope.aliyuncs.com')
$workspaceHost = $endpoint.Host -match '^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$'
if (-not $workspaceHost -and $endpoint.Host -notin $knownLegacy) { throw 'This helper accepts official Bailian workspace or DashScope hosts only. Use configure-model.cmd for another authorized provider.' }
if ($endpoint.AbsolutePath -eq '/') { $address += '/compatible-mode/v1' }
elseif ($endpoint.AbsolutePath.TrimEnd('/') -ne '/compatible-mode/v1') { throw 'Use API Host or a Base URL ending with /compatible-mode/v1, not the full /chat/completions URL.' }
$thinkingOption = if ($Model -match '^qwen3\.5-omni-(plus|flash)(-\d{4}-\d{2}-\d{2})?$') { 'omit' } else { 'false' }
& (Join-Path $PSScriptRoot 'configure-model.ps1') -BaseUrl $address -Model $Model -TokenParameter 'max_completion_tokens' -InstructionRole 'system' -EnableThinking $thinkingOption -OutputFormat 'role-json' -Temperature '0.3' -PresencePenalty '0'
