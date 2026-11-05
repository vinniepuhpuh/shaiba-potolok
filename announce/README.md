# Объявления об обновлениях

`latest.txt` — текст поста для Telegram-канала игры. Когда этот файл меняется в ветке `main`, GitHub Actions публикует его в канал (файл `.github/workflows/announce.yml`).

Нужны два секрета репозитория (Settings → Secrets and variables → Actions):
- `TG_BOT_TOKEN` — токен бота от @BotFather;
- `TG_CHANNEL` — адрес канала, например `@genmanager_news` (бот должен быть администратором канала с правом публикации).

Повторить последний пост вручную: Actions → «Объявление в Telegram» → Run workflow.
