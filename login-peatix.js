const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  // 状態保存用のディレクトリを準備
  const stateDir = path.join(__dirname, '../state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // ブラウザを起動（目視確認と手動操作ができるように headless: false に設定）
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Peatixのログインページに移動します...');
  await page.goto('https://peatix.com/signin');

  console.log('\n===========================================================');
  console.log('ブラウザが開きました。手動でログイン操作を行ってください。');
  console.log('（ロボットチェックや2段階認証がある場合もそのまま進めてください）');
  console.log('===========================================================\n');

  try {
    // ログインが完了し、トップページ（https://peatix.com/）に遷移するまで無限に待機します
    // ※環境によってリダイレクト先が異なる場合はURLの条件を調整してください
    await page.waitForURL('https://peatix.com/', { timeout: 0 });
    
    // ページ遷移後、Cookie等が確実にセットされるまで少し待機
    await page.waitForTimeout(3000); 
    
    console.log('ログイン成功を確認しました！セッション情報を保存します...');
    const statePath = path.join(stateDir, 'peatix-state.json');
    await context.storageState({ path: statePath });

    console.log(`✅ セッション情報を保存しました: ${statePath}`);
    console.log('次回以降は、このファイルを使ってログイン状態を復元できます。');
  } catch (error) {
    console.error('エラーが発生しました:', error);
  } finally {
    await browser.close();
  }
})();
