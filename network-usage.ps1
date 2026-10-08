$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$iteration = 0
$physicalIds = @{}
while ($true) {
    try {
        if (($iteration % 30) -eq 0) {
            $nextIds = @{}
            Get-NetAdapter -Physical | ForEach-Object {
                $nextIds[$_.InterfaceGuid.ToString().Trim('{}').ToLowerInvariant()] = $true
            }
            $physicalIds = $nextIds
        }
        $interfaces = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $physicalIds.ContainsKey($_.Id.Trim('{}').ToLowerInvariant()) } |
            ForEach-Object {
                $stats = $_.GetIPStatistics()
                @{ id = $_.Id; name = $_.Name; received = $stats.BytesReceived; sent = $stats.BytesSent }
            })
        @{ timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); interfaces = $interfaces } |
            ConvertTo-Json -Compress -Depth 4 | ForEach-Object { [Console]::WriteLine($_) }
        $iteration++
    } catch {
        [Console]::WriteLine('{"error":true}')
        $iteration = 0
    }
    Start-Sleep -Milliseconds 1000
}
