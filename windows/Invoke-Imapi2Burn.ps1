param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
$OutputEncoding = $utf8

function Send-Status {
    param(
        [string]$Type,
        [int]$Percent,
        [string]$Message
    )

    [pscustomobject]@{
        type = $Type
        percent = $Percent
        message = $Message
    } | ConvertTo-Json -Compress -Depth 3
}

function Write-ProgressStatus {
    param(
        [int]$Percent,
        [string]$Message
    )

    Send-Status -Type "progress" -Percent $Percent -Message $Message
}

function Open-ReadStream {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "File to burn not found: $Path"
    }

    return [DiscFlow.ManagedIStream]::OpenRead($Path)
}

try {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "Burn manifest not found: $ManifestPath"
    }

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 |
        ConvertFrom-Json

        Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace DiscFlow
{
    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class ManagedIStream : IStream, IDisposable
    {
        private Stream stream;

        public ManagedIStream(Stream source)
        {
            if (source == null) throw new ArgumentNullException("source");
            stream = source;
        }

        public static ManagedIStream OpenRead(string path)
        {
            return new ManagedIStream(
                new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)
            );
        }

        public void Read(byte[] buffer, int count, IntPtr bytesRead)
        {
            int value = stream.Read(buffer, 0, count);
            if (bytesRead != IntPtr.Zero)
            {
                WritePointer(bytesRead, value);
            }
        }

        public void Write(byte[] buffer, int count, IntPtr bytesWritten)
        {
            throw new NotSupportedException("The burn stream is read-only.");
        }

        public void Seek(long offset, int origin, IntPtr newPosition)
        {
            long value = stream.Seek(offset, (SeekOrigin)origin);
            if (newPosition != IntPtr.Zero)
            {
                WritePointer(newPosition, value);
            }
        }

        public void SetSize(long newSize)
        {
            throw new NotSupportedException("The burn stream is read-only.");
        }

        public void CopyTo(
            IStream destination,
            long count,
            IntPtr bytesRead,
            IntPtr bytesWritten)
        {
            if (destination == null)
            {
                throw new ArgumentNullException("destination");
            }

            byte[] buffer = new byte[81920];
            long remaining = count;
            long copied = 0;
            while (remaining > 0)
            {
                int requested = (int)Math.Min(buffer.Length, remaining);
                int read = stream.Read(buffer, 0, requested);
                if (read == 0)
                {
                    break;
                }

                IntPtr written = Marshal.AllocHGlobal(sizeof(int));
                try
                {
                    destination.Write(buffer, read, written);
                    copied += read;
                }
                finally
                {
                    Marshal.FreeHGlobal(written);
                }
                remaining -= read;
            }

            if (bytesRead != IntPtr.Zero)
            {
                WritePointer(bytesRead, copied);
            }
            if (bytesWritten != IntPtr.Zero)
            {
                WritePointer(bytesWritten, copied);
            }
        }

        public void Commit(int flags)
        {
        }

        public void Revert()
        {
            throw new NotSupportedException();
        }

        public void LockRegion(long offset, long count, int lockType)
        {
            throw new NotSupportedException();
        }

        public void UnlockRegion(long offset, long count, int lockType)
        {
            throw new NotSupportedException();
        }

        public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG statstg, int flags)
        {
            statstg = new System.Runtime.InteropServices.ComTypes.STATSTG();
            statstg.type = 2;
            statstg.cbSize = stream.Length;
            statstg.grfMode = 0;
            statstg.grfLocksSupported = 0;
        }

        public void Clone(out IStream clone)
        {
            throw new NotSupportedException();
        }

        public void Dispose()
        {
            if (stream != null)
            {
                stream.Dispose();
                stream = null;
            }
        }

        private static void WritePointer(IntPtr target, long value)
        {
            if (IntPtr.Size == 8)
            {
                Marshal.WriteInt64(target, value);
            }
            else
            {
                Marshal.WriteInt32(target, checked((int)value));
            }
        }
    }
}
"@

    Write-ProgressStatus -Percent 8 -Message "Checking for disc recorders"

    $discMaster = New-Object -ComObject "IMAPI2.MsftDiscMaster2"
    if ($discMaster.Count -eq 0) {
        throw "No available disc recorder detected"
    }

    $selectedRecorder = $null
    $availableDrives = @()
    $desiredDrive = ([string]$manifest.drive).Trim().TrimEnd("\", ":").ToUpperInvariant()

    for ($index = 0; $index -lt $discMaster.Count; $index++) {
        $recorder = New-Object -ComObject "IMAPI2.MsftDiscRecorder2"
        $recorder.InitializeDiscRecorder($discMaster.Item($index))

        $drivePaths = @($recorder.VolumePathNames)
        foreach ($drivePath in $drivePaths) {
            $normalised = ([string]$drivePath).TrimEnd("\", ":").ToUpperInvariant()
            $availableDrives += $normalised
            if (-not $selectedRecorder -and (-not $desiredDrive -or $normalised -eq $desiredDrive)) {
                $selectedRecorder = $recorder
            }
        }
    }

    if (-not $selectedRecorder) {
        $driveList = if ($availableDrives.Count -gt 0) {
            $availableDrives -join ", "
        }
        else {
            "No drive letters"
        }
        throw "Recorder '$desiredDrive' not found. Available devices: $driveList"
    }

    Write-ProgressStatus -Percent 14 -Message "Confirming blank media"

    $formatData = New-Object -ComObject "IMAPI2.MsftDiscFormat2Data"
    $formatData.Recorder = $selectedRecorder
    $formatData.ClientName = "DiscFlow"
    $formatData.BufferUnderrunFreeDisabled = $false

    if (-not $formatData.IsRecorderSupported($selectedRecorder)) {
        throw "The current recorder is not supported by the IMAPI2 data writing interface"
    }
    if (-not $formatData.IsCurrentMediaSupported($selectedRecorder)) {
        throw "The current media is not supported by this recorder"
    }
    if (-not ($formatData.MediaPhysicallyBlank -or $formatData.MediaHeuristicallyBlank)) {
        throw "Please insert a blank writable disc. To avoid accidental erasure, this task will not automatically overwrite existing content."
    }

    $dataStream = $null
    $fileSystemImage = $null
    $fileSystemResult = $null

    try {
        if ($manifest.mode -eq "iso") {
            Write-ProgressStatus -Percent 24 -Message "Opening ISO image"
            $dataStream = Open-ReadStream -Path ([string]$manifest.isoPath)
        }
        elseif ($manifest.mode -eq "files") {
            Write-ProgressStatus -Percent 22 -Message "Preparing disc file system"
            $fileSystemImage = New-Object -ComObject "IMAPI2FS.MsftFileSystemImage"
            $fileSystemImage.VolumeName = [string]$manifest.discName
            # ISO9660 (1) + Joliet (2), readable by Windows, macOS and Linux.
            $fileSystemImage.FileSystemsToCreate = 3
            $fileSystemImage.Root.AddTree([string]$manifest.sourceDirectory, $true)
            $fileSystemResult = $fileSystemImage.CreateResultImage()
            $dataStream = $fileSystemResult.ImageStream

            if ($fileSystemResult.TotalBlocks * $fileSystemResult.BlockSize -gt $formatData.TotalSectorsOnMedia * 2048) {
                throw "The selected files exceed the current media capacity"
            }

            Write-ProgressStatus -Percent 38 -Message "Disc file system has been generated"
        }
        else {
            throw "Unknown task mode: $($manifest.mode)"
        }

        Write-ProgressStatus -Percent 52 -Message "Writing disc data. Do not remove the disc"
        $cancelled = $false

        try {
            $formatData.Write($dataStream, [ref]$cancelled)
        }
        catch [System.Management.Automation.MethodException] {
            # Some PowerShell/IMAPI versions expose the out parameter as optional.
            $formatData.Write($dataStream)
        }

        if ($cancelled) {
            throw "Burning was cancelled by the system"
        }

        Write-ProgressStatus -Percent 96 -Message "Closing disc session"
    }
    finally {
        if ($fileSystemResult -and $fileSystemResult -is [System.IDisposable]) {
            $fileSystemResult.Dispose()
        }
        if ($fileSystemImage -and $fileSystemImage -is [System.IDisposable]) {
            $fileSystemImage.Dispose()
        }
        if ($dataStream -and $dataStream -is [System.IDisposable]) {
            $dataStream.Dispose()
        }
        if ($formatData) {
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($formatData)
        }
        if ($selectedRecorder) {
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($selectedRecorder)
        }
    }

    Write-ProgressStatus -Percent 100 -Message "Burning completed"
    exit 0
}
catch {
    $message = $_.Exception.Message
    Send-Status -Type "error" -Percent 0 -Message $message
    [Console]::Error.WriteLine($message)
    exit 1
}
