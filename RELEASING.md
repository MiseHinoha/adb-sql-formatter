# 发布 / Releasing

两条通道，效果完全一样（同一个 publisher、同一个扩展 ID，用户在扩展面板里搜到的也是同一个），
区别只在"谁把包递上去"。

## 通道一：手动上传 vsix（首发、应急用）

```
npx @vscode/vsce package
```

然后到 <https://marketplace.visualstudio.com/manage/publishers/YipTszkwan> →
`New extension → Visual Studio Code` → 拖入 `adb-sql-formatter-<版本>.vsix`。
不需要任何凭据，只要用拥有该 publisher 的微软账号登录。

## 通道二：打 tag 自动发布（长期方案，见 `.github/workflows/publish.yml`）

> 已知坑：`vsce` **4.0.0** 的 `--oidc` 在换 Marketplace 凭据时请求没带 `api-version`，会直接 400
> （`No api-version was supplied for the POST request`）。`4.0.1-1` 起已修（URL 补 `?api-version=7.2-preview.1`），
> 工作流里已钉住该版本；等 4.0.1 正式版出来可以换成 `@4.0.1`。

前置条件（只需配一次，在 Marketplace 网页上做）：

1. 登录 <https://marketplace.visualstudio.com/manage/publishers/YipTszkwan>；
2. 给这个 publisher 配置 trusted publishing policy，指向仓库 `MiseHinoha/adb-sql-formatter`
   与 workflow 文件名 `publish.yml`；
3. 之后 `git tag v1.4.0 && git push origin v1.4.0` 就会自动：跑 `npm test` → 校验 tag 与
   `package.json` 版本一致 → 打包 → 发 Marketplace → 建同名 GitHub Release 并挂上 vsix。

**为什么不用 PAT**：Azure DevOps 的全局 Personal Access Token 于 **2026-12-01 退役**，
现在建 PAT 等于给自己埋一个到期日。trusted publishing 走 OIDC：workflow 向 GitHub 要一个
`audience=marketplace.visualstudio.com` 的 OIDC token，再由 `vsce` 换成短期 Marketplace 凭据，
仓库里不存任何长期密钥（`vsce` 目前只支持 GitHub Actions 作为 OIDC 提供方，其他 CI 不行）。

### 配好 policy 之前先验证一次

`Actions → Publish → Run workflow`，保持 `verify_only = true`：它会用**已经发布过的版本号**
加 `--skip-duplicate` 去撞一次，认证链走通就成功退出、不会改动任何已上架内容。
这样能在真发布之前确认 policy、`id-token: write`、工作流文件名三处都对得上。

## 版本号规则

`package.json` 的 `version` 与 tag 必须一致，且**同一版本号不能重复上传**，改动后要抬版本：

- 用户可见的排版规则变化 → 次版本（会重排已有文件）
- 只增提示、不改排版 → 修订号

规则与 `CHANGELOG.md` 顶部的约定一致；发版前先更新 `CHANGELOG.md`。

## 发布之后

- Marketplace 会对每个新包跑恶意软件与密钥扫描，**扫描清空才对外可见**（通常几分钟，偶尔更久）；
- 已安装用户由 VS Code 自动更新，无需手动通知；
- verified publisher 蓝勾需"扩展上架 ≥ 6 个月 + 自有域名 ≥ 6 个月"两者同时满足，
  不是发布的前置条件（自有域名可用 `mise-studio.com`，日后够条件再申请）。
