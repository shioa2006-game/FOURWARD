# FOURWARD 開発メモ（Claude 向け）

## 言語
- ユーザーへの回答・質問・確認はすべて**日本語**で行うこと。
- 作業終わりに表示する「次のステップ」欄（要約・質問・ボタンの文言）も日本語で書く。英語で質問しない。
- コミットメッセージ、README.md / GAME_DESIGN.md / TEST_REPORT.md も日本語で書く。

## 作業の基本
- 修正後は `npm run typecheck`、`npm test`、`npm run build`、`npm run e2e` で確認する。
- 公開版（GitHub Pages）は `dist/index.html` を配信しているため、修正後は必ずビルドしてからコミットする。
- コミットとプッシュは、ユーザーに頼まれた時だけ行う。
