# 发布 / Releasing

两条通道，效果完全一样（同一个 publisher、同一个扩展 ID，用户在扩展面板里搜到的也是同一个），
区别只在"谁把包递上去"。

## 通道一：手动上传 vsix（首发、应急用）

```
npm run package          # 输出到 dist/adb-sql-formatter-<版本>.vsix
```

然后到 <https://marketplace.visualstudio.com/manage/publishers/YipTszkwan> →
`New extension → Visual Studio Code` → 拖入 `dist/adb-sql-formatter-<版本>.vsix`。
不需要任何凭据，只要用拥有该 publisher 的微软账号登录。

## 通道二：打 tag 自动发布（长期方案，见 `.github/workflows/publish.yml`）

> 已知坑：`vsce` **4.0.0** 的 `--oidc` 在换 Marketplace 凭据时请求没带 `api-version`，会直接 400
> （`No api-version was supplied for the POST request`）。`4.0.1-1` 起已修；
> **trusted publishing 正式开放（2026-10-28）时官方发布的是 `4.1.0`**，工作流已钉在它上面
> （`4.1.0` 才包含 #1337 对齐 Marketplace 的交换契约、#1345 的 `X-Market-CI-Provider` 头，
> 官方与社区都是用这个版本验证通过的）。

前置条件（只需配一次，在 Marketplace 网页上做）：

1. 登录 <https://marketplace.visualstudio.com/manage/publishers/YipTszkwan>，选 publisher →
   **Trusted Publishing** → 展开 **Create**，按官方字段填：
   - **Policy name**：随便写，如 `Release workflow`
   - **Repository owner**：`MiseHinoha`
   - **Repository**：`adb-sql-formatter`
   - **Workflow**：`publish.yml`（只写文件名，大小写敏感，不写 `.github/workflows/` 路径）
   - **Environment**：**留空**（本工作流没有用 GitHub environment）
2. 把仓库变量 `MARKETPLACE_TRUSTED_PUBLISHING` 设为 `true`（Settings → Secrets and variables →
   Actions → Variables）；
3. 之后 `git tag v1.5.1 && git push origin v1.5.1` 就会自动：跑 `npm test` → 校验 tag 与
   `package.json` 版本一致 → 打包 → 发 Marketplace → 建同名 GitHub Release 并挂上 vsix。

> **状态（2026-11-09 起）：入口已开放**。Marketplace 于 **2026-10-28** 正式发布 trusted
> publishing（官方博客 + `microsoft/vscode-docs`），服务端换票端点从
> `Trusted Publishing is not supported.` 变成按 `FederatedToken` 方案校验 token：
> 带假 token 打 `_apis/gallery/token` 现在回
> `The token could not be exchanged for the specified publisher.`（401），
> 说明端点已上线、只剩 publisher 侧的 policy 没配。
> 切换已于 **2026-11-09** 完成：policy 建好（owner `MiseHinoha` / repo `adb-sql-formatter` /
> workflow `publish.yml` / Environment 留空）、`verify_only` 验证跑通（run 42567513324，换票成功、
> 未发布任何内容）、仓库变量 `MARKETPLACE_TRUSTED_PUBLISHING` 已设为 `true`。
> 从那以后推 `v*` tag 即全自动发布；要临时关掉把该变量改回 `false` 或删掉即可。

**为什么不用 PAT**：Azure DevOps 的全局 Personal Access Token 于 **2026-12-01 退役**，
现在建 PAT 等于给自己埋一个到期日。trusted publishing 走 OIDC：workflow 向 GitHub 要一个
`audience=marketplace.visualstudio.com` 的 OIDC token，再由 `vsce` 换成短期 Marketplace 凭据，
仓库里不存任何长期密钥（`vsce` 目前只支持 GitHub Actions 作为 OIDC 提供方，其他 CI 不行）。

### 入口开放后，先验证一次再真发

`Actions → Publish → Run workflow`，保持 `verify_only = true`：它会用**已经发布过的版本号**
加 `--skip-duplicate` 去撞一次，认证链走通就成功退出、不会改动任何已上架内容。
这样能在真发布之前确认 policy、`id-token: write`、工作流文件名三处都对得上。

> 这一跑不需要先把仓库变量设为 `true`，也不会发布任何东西 —— 只要 policy 配对了就会绿。
> policy 没建或字段（owner/repo/workflow/Environment）对不上时，这一步会红在换票处，
> 报 `The token could not be exchanged for the specified publisher.`——那是 policy 问题，不是凭据问题。

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
