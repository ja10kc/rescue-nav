# 山岳救助ナビ（iPad PWA）

消防航空隊ヘリコプター山岳救助向けの現場誘導Webアプリです。ビルド不要（HTML / CSS / JavaScriptのみ）で、静的ホスティングにそのまま置けます。

```
rescue-nav/
├─ index.html          画面
├─ css/style.css       デザイン（昼／夜テーマ）
├─ js/geo.js           座標変換・距離/方位計算（Vincenty法・端末内で完結）
├─ js/app.js           GPS・地図・ダッシュボード・テストモード・Wake Lock
├─ manifest.json       PWA設定
├─ service-worker.js   オフラインキャッシュ
├─ icons/              アプリアイコン
└─ assets/nosleep.mp4  Wake Lock非対応時のスリープ防止用（無音動画）
```

---

## 1. Windows PCでのローカル動作確認

1. このフォルダでコマンドプロンプト（または PowerShell）を開きます。
2. 次のどちらかでローカルサーバーを起動します。
   - Python がある場合：`python -m http.server 8000`
   - Node.js がある場合：`npx serve -l 8000`
3. Chrome または Edge で **http://localhost:8000** を開きます。
   - `localhost` は安全なコンテキストとして扱われるため、GPS（位置情報）や Service Worker も動きます。
   - PCにはGPSがないため、右上の **「テストモード」** で模擬移動を確認してください。
   - Chrome DevTools（F12）→「⋮」→ More tools → **Sensors** で任意の位置を擬似的に設定することもできます。

> ⚠ `index.html` をダブルクリックして直接開く方法（file://）では、Service Worker と位置情報が動きません。必ずサーバー経由で開いてください。

---

## 2. iPad実機への配信（HTTPS必須）

GPSはHTTPSでないと使えません。以下のどれかで配信します。

### A. GitHub Pages（おすすめ・無料）
1. GitHubで新しいリポジトリを作り、このフォルダの中身をそのままアップロード（「Add file → Upload files」でドラッグ＆ドロップ可）。
2. リポジトリの **Settings → Pages** → Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして Save。
3. 1〜2分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

### B. Cloudflare Pages
1. Cloudflareダッシュボード → **Workers & Pages → Create → Pages → Upload assets**。
2. このフォルダをドラッグ＆ドロップしてデプロイ。`https://<プロジェクト名>.pages.dev/` で公開されます。

### C. 公開せずにPCから一時的に試す
`cloudflared tunnel --url http://localhost:8000` を実行すると、一時的な `https://xxxx.trycloudflare.com` のURLが発行されます。iPadからそのURLを開いて試せます。

### iPad側の設定
1. Safariで公開URLを開き、位置情報の許可を求められたら「許可」。
2. 共有ボタン →「**ホーム画面に追加**」。以後はホーム画面のアイコンから全画面で起動します。
3. 「設定」→「プライバシーとセキュリティ」→「位置情報サービス」→ **Safari Webサイト** を「使用中のみ許可」、**正確な位置情報** をオン。
4. 念のため「設定」→「画面表示と明るさ」→「自動ロック」を **なし** にしておくと確実です。

---

## 3. 運用上の注意（重要）

- **Wi-Fiモデルの iPad にはGPSがありません。** 上空ではWi-Fi測位ができないため、**Cellularモデル**（GPS/GNSS内蔵）を使うか、外付けGNSSレシーバー（Bluetooth接続でiOSの位置情報に反映されるもの）を使ってください。
- **出動前に一度オンラインで起動**してください。アプリ本体と地図ライブラリが端末に保存され、以後は電波がなくても距離・方位・ETEの計算が動きます。
- 地図は、一度表示した範囲がキャッシュされます。現場が分かったら地上で **「現場周辺の地図を保存」** を押すと、現場の半径約3km（ズーム10〜16）と、現在地からのルート沿いを保存します（地理院地図のみ。OSMは利用規約により一括保存不可）。
- **標高**は現場座標の確定時に国土地理院APIから取得します。通信できない場合は「失敗」と表示され、電波が戻ると自動で再取得します（「再取得」ボタンもあります）。
- **GPS高度**は誤差を含む目安です（垂直精度 ±◯m を併記）。航空機の高度計の代わりにはなりません。
- 方位は**真方位**です（磁方位ではありません）。
- **画面ON維持**：Screen Wake Lock APIを使います（ホーム画面から起動したアプリでは iPadOS 18.4 以降で有効）。非対応時は無音動画を使う方式に自動で切り替わります。上部の表示が赤い場合はタップして有効にしてください。

## 4. 更新方法

ファイルを修正したら `service-worker.js` の `CACHE_VERSION`（例：`v1.0.0` → `v1.0.1`）を上げてから再デプロイしてください。iPadでアプリを開き直すと「新しいバージョンがあります」と表示され、再起動で反映されます。

## 5. 同梱ライブラリとライセンス

- `vendor/leaflet/`：Leaflet 1.9.4（BSD-2-Clause）
- `vendor/leaflet-rotate/`：leaflet-rotate 0.6.2（**GPL-3.0**）— 地図の回転（機首方向が上）に使用

どちらも `vendor/` 内に LICENSE を同梱しています。leaflet-rotate はGPL-3.0のため、アプリを外部に配布する場合はGPLの条件（ソースコードの提供など）に従ってください。隊内での利用だけなら通常は問題ありません。leaflet-rotate を読み込めない場合も、地図は「北が上」で動作します。

---

地図：国土地理院（地理院タイル）／ © OpenStreetMap contributors　標高：国土地理院 標高API
