# Generate an original spoken fixture using the Windows system speech engine.
$taskRoot = Split-Path -Parent $PSScriptRoot
$fixturePath = Join-Path $taskRoot 'models/audio-fixture.wav'
$speaker = New-Object -ComObject SAPI.SpVoice
$stream = New-Object -ComObject SAPI.SpFileStream
try {
    $stream.Format.Type = 18
    $stream.Open($fixturePath, 3, $false)
    $speaker.AudioOutputStream = $stream
    [void]$speaker.Speak('The meeting starts at nine. We decided to finish the report tomorrow.', 0)
} finally {
    $stream.Close()
}
Write-Output $fixturePath
