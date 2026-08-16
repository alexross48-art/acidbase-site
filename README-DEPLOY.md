# Публикация с любого компьютера (только браузер)

## Один раз
1. github.com → New repository → имя `acidbase-site`, Private → Create.
2. "uploading an existing file" → перетащить ВСЁ содержимое этой папки
   (index.html, privacy.html, netlify.toml, package.json, папку netlify) → Commit.
3. app.netlify.com → Add new site → Import an existing project → GitHub → выбрать репозиторий.
   Build command оставить пустым, Publish directory: `.` → Deploy.
4. Site configuration → Environment variables → добавить:
      TRIAL_SECRET   = (тот же, что в приложении)
      INVITE_CODES   = TRIAL-AAAAA,TRIAL-BBBBB,...   (коды через запятую)
   → Deploys → Trigger deploy.
5. Site configuration → Domain management → переименовать сайт в понятное имя,
   например acidbase-scout.netlify.app.

## Проверка
- Открыть сайт с телефона, ввести свой Device ID (2VR6-P5KA) и один из кодов —
  должен вернуться тот же ключ, который делает make-key на Маке.
- Второй телефон с тем же кодом должен получить отказ.

## Потом, на Маке (не с работы)
- В src/AcidBaseScout.jsx заменить FEEDBACK_ENDPOINT на
  https://<ИМЯ>.netlify.app/api/feedback и пересобрать.
- Перед выдачей ключей врачам: сменить TRIAL_SECRET со значения по умолчанию
  в приложении, в make-key и в Netlify — одновременно.

## Плейсхолдеры в файлах
- index.html: YOUR_APK_LINK (ссылка на APK — удобнее всего GitHub Releases),
  YOUR@EMAIL (двa места: index и privacy).
