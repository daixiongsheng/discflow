# IMAPI2 刻录代理

`Invoke-Imapi2Burn.ps1` 由 NestJS 以独立进程调用，任务清单通过 `-ManifestPath` 传入。

执行流程：

1. `IMAPI2.MsftDiscMaster2` 枚举本机刻录机，并可按 `BURN_DRIVE` 选择盘符。
2. `IMAPI2.MsftDiscFormat2Data` 检查刻录机和盘片能力。
3. ISO 模式将文件包装成 COM `IStream`；文件模式通过 `IMAPI2FS.MsftFileSystemImage` 生成 ISO9660/Joliet 镜像流。
4. 数据流直接交给 IMAPI2 写入，不经过第三方 ISO 工具。

## 上线前硬件验收

IMAPI2 与盘片、光驱固件和 Windows 版本有关，必须在目标 Windows 电脑上完成以下检查：

```powershell
# 确认能看到 COM 组件与刻录机
$master = New-Object -ComObject IMAPI2.MsftDiscMaster2
$master.Count

# 直接调用一个任务清单
powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta `
  -File .\windows\Invoke-Imapi2Burn.ps1 `
  -ManifestPath .\data\jobs\<job-id>\burn-manifest.json
```

建议依次使用 CD-R、DVD-R 和目标业务盘片测试。代理会拒绝非空白盘片，避免自动擦除未知内容。若目标只使用 DVD+RW，可在确认业务规则后增加显式的擦除步骤。

