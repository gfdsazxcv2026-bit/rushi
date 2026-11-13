param(
    [string]$BaseUrl,
    [string]$Model,
    [ValidateSet('max_tokens', 'max_completion_tokens')]
    [string]$TokenParameter = 'max_tokens',
    [ValidateSet('system', 'developer')]
    [string]$InstructionRole = 'system',
    [ValidateSet('default', 'true', 'false', 'omit')]
    [string]$EnableThinking = 'default',
    [ValidateSet('default', 'text', 'role-json')]
    [string]$OutputFormat = 'default',
    [string]$Temperature,
    [string]$PresencePenalty
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Write-Host 'Configure the server-side model for Rushi. No network request will be sent.'
if (-not $BaseUrl) { $BaseUrl = Read-Host 'Provider base URL (ending before /chat/completions)' }
if (-not $Model) { $Model = Read-Host 'Exact model name from your provider' }
$BaseUrl = $BaseUrl.Trim().TrimEnd('/')
$Model = $Model.Trim()
$endpoint = $null
if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$endpoint)) { throw 'Invalid provider URL.' }
if ($endpoint.Scheme -notin @('https', 'http') -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment) { throw 'Use an HTTP(S) base URL without credentials, query or fragment.' }
if (-not $Model) { throw 'A model name is required.' }
foreach ($option in @(@('MODEL_TEMPERATURE', $Temperature, 0, 1.99), @('MODEL_PRESENCE_PENALTY', $PresencePenalty, -2, 2))) {
    if ([string]::IsNullOrEmpty($option[1])) { continue }
    $parsedOption = 0.0
    if (-not [double]::TryParse($option[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsedOption) -or [double]::IsNaN($parsedOption) -or [double]::IsInfinity($parsedOption) -or $parsedOption -lt $option[2] -or $parsedOption -gt $option[3]) { throw ('Invalid sampling option: ' + $option[0]) }
}

function Quote-EnvValue([string]$Value) {
    if ($Value.Contains("'") -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Configuration values cannot contain a single quote or line break.' }
    return "'" + $Value + "'"
}

$secret = Read-Host 'API key (hidden; saved only in local .env)' -AsSecureString
$keyPointer = [IntPtr]::Zero
$plainKey = $null
$temporary = Join-Path $PSScriptRoot ('.env.setup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if (-not $plainKey) { throw 'The API key cannot be empty. Existing configuration was not changed.' }
    $managed = [ordered]@{
        MODEL_MODE = 'openai-compatible'
        MODEL_BASE_URL = $BaseUrl
        MODEL_NAME = $Model
        MODEL_API_KEY = $plainKey
        MODEL_TOKEN_PARAMETER = $TokenParameter
        MODEL_INSTRUCTION_ROLE = $InstructionRole
    }
    if ($EnableThinking -ne 'default') { $managed['MODEL_ENABLE_THINKING'] = if ($EnableThinking -eq 'omit') { '' } else { $EnableThinking } }
    if ($OutputFormat -ne 'default') { $managed['MODEL_OUTPUT_FORMAT'] = $OutputFormat }
    if (-not [string]::IsNullOrEmpty($Temperature)) { $managed['MODEL_TEMPERATURE'] = $Temperature }
    if (-not [string]::IsNullOrEmpty($PresencePenalty)) { $managed['MODEL_PRESENCE_PENALTY'] = $PresencePenalty }
    $envPath = Join-Path $PSScriptRoot '.env'
    $sourcePath = $envPath
    if (-not (Test-Path -LiteralPath $sourcePath)) { $sourcePath = Join-Path $PSScriptRoot '.env.example' }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in [IO.File]::ReadAllLines($sourcePath)) {
        if ($line -match '^\s*(?:export\s+)?([A-Z_]+)\s*=' -and $managed.Contains($Matches[1])) { continue }
        $lines.Add($line)
    }
    foreach ($entry in $managed.GetEnumerator()) { $lines.Add($entry.Key + '=' + (Quote-EnvValue $entry.Value)) }
    [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $envPath -Force
    Write-Host 'Saved .env. This confirms local configuration only; authentication and replies have not been tested.'
    Write-Host 'Next: run the static check, then explicitly run --live if you want a small billable connection check.'
    Write-Host 'powershell -NoProfile -ExecutionPolicy Bypass -File .\check-model.ps1'
    Write-Host 'powershell -NoProfile -ExecutionPolicy Bypass -File .\check-model.ps1 -Live'
    Write-Host 'Restart the app with stop.cmd then start.cmd to load the updated configuration.'
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    $plainKey = $null
    if ($secret) { $secret.Dispose() }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
