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
        throw "找不到要刻录的文件：$Path"
    }

    return [DiscFlow.ManagedIStream]::OpenRead($Path)
}

try {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        throw "找不到刻录任务清单：$ManifestPath"
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
            stream = source ?? throw new ArgumentNullException("source");
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

        public void Stat(out STATSTG statstg, int flags)
        {
            statstg = new STATSTG();
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

    Write-ProgressStatus -Percent 8 -Message "正在检查刻录机"

    $discMaster = New-Object -ComObject "IMAPI2.MsftDiscMaster2"
    if ($discMaster.Count -eq 0) {
        throw "没有检测到可用的刻录机"
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
            if (-not $selectedRecorder -and ($not $desiredDrive -or $normalised -eq $desiredDrive)) {
                $selectedRecorder = $recorder
            }
        }
    }

    if (-not $selectedRecorder) {
        $driveList = if ($availableDrives.Count -gt 0) {
            $availableDrives -join ", "
        }
        else {
            "无盘符"
        }
        throw "找不到刻录机 '$desiredDrive'。当前设备：$driveList"
    }

    Write-ProgressStatus -Percent 14 -Message "正在确认空白盘片"

    $formatData = New-Object -ComObject "IMAPI2.MsftDiscFormat2Data"
    $formatData.Recorder = $selectedRecorder
    $formatData.ClientName = "DiscFlow"
    $formatData.BufferUnderrunFreeDisabled = $false

    if (-not $formatData.IsRecorderSupported($selectedRecorder)) {
        throw "当前刻录机不被 IMAPI2 数据写入接口支持"
    }
    if (-not $formatData.IsCurrentMediaSupported($selectedRecorder)) {
        throw "当前盘片不被该刻录机支持"
    }
    if (-not ($formatData.MediaPhysicallyBlank -or $formatData.MediaHeuristicallyBlank)) {
        throw "请放入空白可写盘片。为避免误擦除，本任务不会自动覆写已有内容。"
    }

    $dataStream = $null
    $fileSystemImage = $null
    $fileSystemResult = $null

    try {
        if ($manifest.mode -eq "iso") {
            Write-ProgressStatus -Percent 24 -Message "正在打开 ISO 镜像"
            $dataStream = Open-ReadStream -Path ([string]$manifest.isoPath)
        }
        elseif ($manifest.mode -eq "files") {
            Write-ProgressStatus -Percent 22 -Message "正在整理光盘文件系统"
            $fileSystemImage = New-Object -ComObject "IMAPI2FS.MsftFileSystemImage"
            $fileSystemImage.VolumeName = [string]$manifest.discName
            # ISO9660 (1) + Joliet (2), readable by Windows, macOS and Linux.
            $fileSystemImage.FileSystemsToCreate = 3
            $fileSystemImage.Root.AddTree([string]$manifest.sourceDirectory, $true)
            $fileSystemResult = $fileSystemImage.CreateResultImage()
            $dataStream = $fileSystemResult.ImageStream

            if ($fileSystemResult.TotalBlocks * $fileSystemResult.BlockSize -gt $formatData.TotalSectorsOnMedia * 2048) {
                throw "所选文件超过当前盘片容量"
            }

            Write-ProgressStatus -Percent 38 -Message "光盘文件系统已生成"
        }
        else {
            throw "未知的任务模式：$($manifest.mode)"
        }

        Write-ProgressStatus -Percent 52 -Message "正在写入光盘数据，请勿取出盘片"
        $cancelled = $false

        try {
            $formatData.Write($dataStream, [ref]$cancelled)
        }
        catch [System.Management.Automation.MethodException] {
            # Some PowerShell/IMAPI versions expose the out parameter as optional.
            $formatData.Write($dataStream)
        }

        if ($cancelled) {
            throw "刻录已被系统取消"
        }

        Write-ProgressStatus -Percent 96 -Message "正在关闭光盘会话"
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

    Write-ProgressStatus -Percent 100 -Message "刻录完成"
    exit 0
}
catch {
    $message = $_.Exception.Message
    Send-Status -Type "error" -Percent 0 -Message $message
    [Console]::Error.WriteLine($message)
    exit 1
}

