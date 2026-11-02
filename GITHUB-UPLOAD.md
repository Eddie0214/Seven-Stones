# 把 Seven Stones 上傳到 GitHub

打包檔：`dist/seven-stones-github.zip`

解壓縮後會得到一個 `seven-stones/` 資料夾。請用**資料夾裡的內容**建立 GitHub repo，不要把 zip 直接上傳後就結束；GitHub 不會自動解壓縮。

## 打包內容

已包含：

- `server.cjs`、`game.cjs`、`invitations.cjs`、`google-auth.cjs`、`ai-worker.cjs`
- `public/`（含 `public/index.html`、`app.js`、`engine.js`、`rules.js`、`styles.css`）
- `test/league.test.cjs`
- `package.json`、`pnpm-lock.yaml`
- `Dockerfile`、`compose.yaml`、`compose.oracle.yaml`、`Caddyfile`
- `.env.example`、`.env.oracle.example`
- `README.md`、`DEPLOY-FREE.md`、`ORACLE-DEPLOY.txt`、`CHECKPOINT.md`
- Windows 啟動腳本

已排除：

- `.env`（可能有本機設定）
- `data/`、`*.sqlite`、`*.sqlite-wal`、`*.sqlite-shm`（玩家資料）
- `node_modules/`（部署時會重新安裝）
- 日誌檔

## 方法 1：GitHub Desktop（推薦，最不容易出錯）

1. 解壓縮 `seven-stones-github.zip`。
2. 安裝並開啟 [GitHub Desktop](https://desktop.github.com/)。
3. 登入 GitHub。
4. **File → Add local repository**，選擇解壓縮後的 `seven-stones` 資料夾。
5. 如果它說這不是 Git repository，選 **create a repository**。
6. 左側確認沒有 `.env`、`data/`、`node_modules/`。
7. 在左下角輸入 commit message，例如 `Initial Seven Stones game`，按 **Commit to main**。
8. 按右上角 **Publish repository**。
   - 建議先選 **Private**。
   - 不要勾選「Keep this code private」以外的奇怪選項。
9. 完成後，GitHub 上就會有完整專案。

## 方法 2：GitHub 網頁上傳

1. 到 GitHub 按 **New repository**，建立空 repo。
2. 進入 repo，按 **Add file → Upload files**。
3. 解壓縮後，把 `seven-stones` 資料夾**裡面的所有檔案與資料夾**拖進去。
   - 一定要包含 `public/index.html`。
   - 不要只上傳 zip。
4. 確認檔案列表有：
   - `server.cjs`
   - `package.json`
   - `pnpm-lock.yaml`
   - `Dockerfile`
   - `public/index.html`
   - `public/app.js`
5. 輸入 commit message，按 **Commit changes**。

> GitHub 網頁上傳適合檔案不多的情況；如果拖曳後資料夾結構不對，改用 GitHub Desktop。

## 方法 3：命令列

在解壓縮後的 `seven-stones` 資料夾執行：

```bash
git init
git add .
git commit -m "Initial Seven Stones game"
git branch -M main
git remote add origin https://github.com/你的帳號/你的repo.git
git push -u origin main
```

如果 GitHub 要求登入，使用 Personal Access Token 或 GitHub CLI，不要把密碼貼到程式碼裡。

## 上傳後檢查

打開 GitHub repo，確認：

- [ ] 有 `public/index.html`
- [ ] 有 `server.cjs`
- [ ] 有 `Dockerfile`
- [ ] 有 `package.json` 與 `pnpm-lock.yaml`
- [ ] 沒有 `.env`
- [ ] 沒有 `data/` 或 `*.sqlite`
- [ ] 沒有 `node_modules/`

接著就可以照 `DEPLOY-FREE.md` 部署到 Northflank 或 Oracle。
