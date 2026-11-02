# Seven Stones：免費部署與 Google 登入

這份文件說明如何把這個專案免費放到網路上，並啟用 Google 帳號登入／連結。

> 先說結論：**要「免費、24 小時運行、SQLite 資料不會消失」，最實際的是 Northflank Sandbox 或 Oracle Cloud Always Free。**
> 兩者都需要信用卡做身分驗證，但只要留在免費方案、不超額，就不會被收費。
> Render 免費方案雖然不用信用卡，但沒有持久磁碟，重新部署或重啟就會失去 SQLite 資料，不適合這個遊戲。

## 方案比較

| 方案 | 免費 | SQLite 持久化 | 信用卡驗證 | 難度 | 備註 |
| --- | --- | --- | --- | --- | --- |
| **Northflank Sandbox** | 是 | 是（Volume） | 需要 | 低 | 免費方案官方說不建議當正式生產環境；資源與條款可能變動 |
| **Oracle Cloud Always Free** | 是 | 是（VM 磁碟） | 需要 | 中 | 2026 年 ARM 免費額度為 2 OCPU / 12 GB；實際容量依區域 |
| Render Free | 是 | 否 | 不需要 | 低 | 重啟／重新部署會遺失 SQLite，不建議 |
| Vercel / Netlify | 是 | 否 | 不需要 | 低 | 不適合長時間連線與 SQLite |

---

# 方案 A：Northflank Sandbox（最省事）

## 1. 先上傳到 GitHub

照 `GITHUB-UPLOAD.md` 把這個資料夾的內容上傳到 GitHub。  
**不要上傳** `.env`、`data/`、`node_modules/`；打包檔已經幫你排除。

## 2. 建立 Northflank 帳號

1. 前往 <https://app.northflank.com/signup>。
2. 建立帳號，選擇 **Developer Sandbox（Free）**。
3. 依畫面加入信用卡做身分驗證。免費方案不會主動扣款，但請自行確認方案條款與用量警示。

## 3. 建立 Service

1. 建立一個 Project。
2. 選擇 **Create Service** → **Git repository**，連接你的 GitHub 帳號與剛剛的 repo。
3. Build 設定：
   - Build type：**Dockerfile**
   - Dockerfile path：`/Dockerfile`
   - Build context：`/`
4. 網路設定：
   - Port：`8787`
   - Protocol：HTTP
   - Health check path：`/api/health`
5. Instance：選免費的 Sandbox / 最小方案。

## 4. 掛載持久磁碟

在 Service 的 **Volumes** 頁面：

- 建立一個 Volume（例如 `seven-stones-data`，1 GB 起）。
- Container mount path：`/app/data`

這一步很重要；沒有 Volume 的話，重新部署會清空帳號與對局資料。

## 5. 設定環境變數

在 Service 的 **Environment** 加入：

```text
PORT=8787
HOST=0.0.0.0
DB_PATH=/app/data/league.sqlite
COOKIE_SECURE=1
GOOGLE_CLIENT_ID=
```

`GOOGLE_CLIENT_ID` 可以先留空，等其他步驟拿到 Client ID 再填。  
**不要**把 Google Client Secret 放進來，這個專案不需要它。

## 6. 部署

按下 Deploy，等待建置完成。完成後 Northflank 會給你一個 HTTPS 網址，例如：

```text
https://你的服務名稱.xxxxx.northflank.app
```

打開網址，確認：

- 首頁可以載入；
- `https://你的網址/api/health` 回傳 `{"ok":true,"app":"seven-stones"}`；
- 可以註冊／登入；
- 重新部署後帳號還在（代表 Volume 正常）。

### 如果出現 SQLite 權限錯誤

若 log 出現 `SQLITE_CANTOPEN` 或 `permission denied`，代表容器使用者不能寫入 Volume。  
可以在 Service 的 **Command / Entrypoint** 使用：

```sh
sh -c "chown -R node:node /app/data && exec node server.cjs"
```

並確認 Dockerfile 的 `USER node` 與 Volume 掛載路徑一致。若平台不允許 root 啟動，改用 Oracle 方案會比較簡單。

---

# 方案 B：Oracle Cloud Always Free（較穩定）

這個方案是真正的免費 VM，適合長期運行。完整步驟已寫在 `ORACLE-DEPLOY.txt`，概要如下：

1. 建立 Oracle Cloud 帳號（需要信用卡驗證）。
2. 建立 Ubuntu VM（Always Free；建議至少 1 GB RAM）。
3. 安全性清單開啟 TCP `22`、`80`、`443`。
4. 安裝 Docker 與 Docker Compose。
5. 把專案複製到 VM 的 `/opt/seven-stones`。
6. 準備網域：
   - 自有網域：新增 A 記錄指向 VM 公網 IP；或
   - 免費子網域：使用 DuckDNS 等服務。
7. 設定環境：

```bash
cd /opt/seven-stones
cp .env.oracle.example .env
nano .env
```

至少設定：

```text
COOKIE_SECURE=1
GOOGLE_CLIENT_ID=你的 Client ID
```

8. 啟動：

```bash
docker compose -f compose.yaml -f compose.oracle.yaml up -d --build
```

9. 打開 `https://你的網域`，確認 `/api/health`。

Oracle 的免費額度與可用區域會變動，請以 OCI 控制台顯示為準；不要升級成付費資源。

---

# Google 登入設定

這個專案使用 **Google Identity Services（Sign in with Google）**，只需要 **OAuth Web Client ID**，不需要 Client Secret，也不需要設定 redirect URI。

## 1. 先取得正式網址

Google 需要知道你的網站來源，所以**先完成部署**，拿到像這樣的 HTTPS 網址：

```text
https://你的網域
```

本機測試則使用：

```text
http://localhost:8787
```

## 2. 建立 Google Cloud 專案

1. 前往 <https://console.cloud.google.com/>。
2. 右上角建立新專案，例如 `Seven Stones`。
3. 進入 **Google Auth Platform**（舊版選單叫 OAuth consent screen）。

## 3. 設定 Branding / Audience

1. **Branding**：
   - App name：`Seven Stones`
   - User support email：你的 Email
   - Developer contact email：你的 Email
   - 其他欄位可先留空。
2. **Audience**：
   - 選 **External**。
   - 公開給所有人使用：選 **Publish app**。
   - 只想先測試：留在 **Testing**，並把測試帳號加進 **Test users**。
3. **Data Access / Scopes**：
   - 預設的 `openid`、`email`、`profile` 就夠了。
   - 不需要加入敏感權限，因此通常不需要 Google 驗證。

## 4. 建立 OAuth Client

1. 前往 <https://console.cloud.google.com/auth/clients>。
2. **Create client** → Application type：**Web application**。
3. Name：`Seven Stones Web`。
4. **Authorized JavaScript origins** 加入：

```text
https://你的網域
http://localhost:8787
```

注意：

- 只能填「來源」，不能有路徑、結尾斜線或 `*`。
- 正式站必須是 `https://`；`localhost` 是例外。
- 這個專案用 popup 模式，**不需要**填 Authorized redirect URIs。
- 如果之後換網域，記得回來更新。

5. 建立後複製 **Client ID**，長得像：

```text
1234567890-xxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

## 5. 填入伺服器環境變數

在 Northflank（或 Oracle 的 `.env`）設定：

```text
GOOGLE_CLIENT_ID=1234567890-xxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

同時確認：

```text
COOKIE_SECURE=1
```

重新部署／重啟伺服器。

## 6. 驗證

1. 打開網站。
2. 若已經用名稱／密碼登入，點右上角帳號 → 登入視窗會出現 Google 按鈕；點下去即可**連結**目前玩家。
3. 若尚未登入，Google 按鈕會建立一個新的 Google 玩家帳號。
4. 到 `https://你的網址/api/state` 確認 `server.googleEnabled` 是 `true`。

### 這個專案的連結規則

- 一個玩家只能連結一個 Google 帳號。
- 同一個 Google 帳號不能連結到兩個玩家。
- **不會用 Email 自動合併帳號**，避免把不同玩家誤合併。
- 已連結的玩家，之後可以直接用 Google 登入。

## 7. 常見錯誤

| 訊息 / 現象 | 原因 | 處理 |
| --- | --- | --- |
| `origin_mismatch` / `The given origin is not allowed` | Authorized JavaScript origin 與實際網址不完全一致 | 加入完全相同的 `https://網域`，不要有斜線或路徑；等幾分鐘再試 |
| 看不到 Google 按鈕 | `GOOGLE_CLIENT_ID` 沒設定或沒重啟 | 檢查環境變數，重新部署；打開 `/api/state` 看 `googleEnabled` |
| `Google login is not configured` | 伺服器沒有 Client ID | 同上 |
| 登入後馬上變回訪客 | Cookie 被瀏覽器拒絕 | 正式站必須 HTTPS，並設 `COOKIE_SECURE=1` |
| `This player already has a linked Google account` | 這個玩家已連結過 | 用原本連結的 Google 帳號登入 |
| `That Google account is already linked to another player` | 這個 Google 帳號已綁定別的玩家 | 改用另一個 Google 帳號，或登入原本的玩家 |
| 按鈕空白 / popup 被擋 | 瀏覽器阻擋彈窗，或 CSP 問題 | 允許彈窗；確認伺服器是最新版本 |

## 8. 安全提醒

- **Client ID 是公開資訊**，可以放在前端；**Client Secret 絕對不要**放進 GitHub、`.env.example` 或前端。
- 不要把 `.env`、`data/`、`*.sqlite` 上傳到 GitHub。
- 免費方案不保證永久可用，請定期備份 `/app/data/league.sqlite`。
- 本遊戲沒有真實金錢交易；不要加入任何「保證獲利」或「線上人數」的假資料。
