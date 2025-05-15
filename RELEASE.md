# 版本发布指南

## 自动发布流程

本项目使用 GitHub Actions 自动打包并发布可执行文件到 GitHub Releases。

### 如何发布新版本

1. 确保所有更改已经提交并推送到主分支

2. 为新版本创建一个标签并推送：
   ```bash
   # 更新版本号（例如从0.1.2到0.1.3）
   npm version patch   # 小版本更新，例如 0.1.2 -> 0.1.3
   # 或者
   npm version minor   # 中等版本更新，例如 0.1.2 -> 0.2.0
   # 或者
   npm version major   # 主要版本更新，例如 0.1.2 -> 1.0.0
   
   # 推送代码和标签到远程仓库
   git push && git push --tags
   ```

3. GitHub Actions 将自动执行以下操作：
   - 构建项目
   - 为每个支持的平台打包可执行文件:
     - Windows x64
     - macOS Intel x64
     - macOS Apple Silicon (M系列)
   - 创建一个新的 GitHub Release
   - 将可执行文件上传到该 Release

4. 发布完成后，可以在 GitHub 仓库的 Releases 页面查看和下载所有平台的可执行文件。

### 支持的平台

- **Windows x64**: `mcp_server-win-x64.exe`
- **macOS Intel x64**: `mcp_server-macos-x64`
- **macOS Apple Silicon (M系列)**: `mcp_server-macos-arm64`

### 手动触发发布

如果需要手动触发发布流程，可以执行以下步骤：

1. 创建并推送一个带有 `v` 前缀的标签（例如 `v1.0.0`）:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. GitHub Actions 将自动执行发布流程。

### 注意事项

- 确保在发布前已经更新了 `package.json` 中的版本号
- 发布前最好运行测试，确保所有功能正常
- 请确保您的 GitHub 仓库设置中，Actions 有权限访问 `secrets.GITHUB_TOKEN` 