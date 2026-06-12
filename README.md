# Discord YouTube Music Bot

Бот подключается к голосовому каналу Discord, принимает YouTube-ссылки или поисковые запросы через slash-команды и ведет очередь треков для каждого сервера.

## Быстрый старт

Требования:

- Node.js 22.12 или новее.
- Python 3.9 или новее: нужен пакету `youtube-dl-exec`, который скачивает актуальный бинарник `yt-dlp` при `npm install`.

1. Установи зависимости:

```bash
npm install
```

2. Скопируй `.env.example` в `.env` и заполни:

```env
DISCORD_TOKEN=токен_бота
DISCORD_CLIENT_ID=id_приложения
DISCORD_GUILD_ID=id_сервера_для_быстрой_регистрации
DEFAULT_VOICE_CHANNEL_ID=id_общего_войса_если_нужен
```

3. Зарегистрируй команды:

```bash
npm run deploy
```

4. Запусти бота:

```bash
npm start
```

## Команды

- `/play query:<ссылка или текст>` - добавить один YouTube-трек в очередь и начать проигрывание. Если ссылка содержит `v=...&list=...`, будет добавлено только видео из `v=...`.
- `/playlist url:<ссылка>` - добавить весь YouTube-плейлист из `list=...` в очередь.
- `/search query:<текст>` - показать 5 результатов YouTube и добавить выбранный результат кнопкой.
- `/queue` - показать очередь.
- `/nowplaying` - показать текущий трек.
- `/skip` - пропустить текущий трек.
- `/pause` - поставить на паузу.
- `/resume` - продолжить.
- `/stop` - остановить музыку, очистить очередь и выйти.
- `/join channel:<канал>` - подключиться к войсу.
- `/leave` - выйти из войса.

Если `DEFAULT_VOICE_CHANNEL_ID` заполнен, бот всегда использует этот общий войс. Если поле пустое, бот подключается к голосовому каналу пользователя, который вызвал команду.

## Настройка Discord-приложения

В Discord Developer Portal создай application и bot, затем скопируй token и application/client ID в `.env`.

Для invite-ссылки включи scopes:

- `bot`
- `applications.commands`

Минимальные права бота на сервере:

- View Channels
- Send Messages
- Read Message History
- Attach Files
- Connect
- Speak

Для реакции на сообщения в чате включи в Discord Developer Portal:

- Bot
- Privileged Gateway Intents
- Message Content Intent

Если при запуске появляется `Used disallowed intents`, значит `Message Content Intent` еще не включен у приложения в Developer Portal.

Бот реагирует на список явных матерных триггеров из `src/insult-triggers.js`: отправляет Tenor GIF и пингует автора сообщения.

Используй только контент, который можно воспроизводить в рамках правил YouTube, Discord и прав владельцев контента.
