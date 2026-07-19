param(
  [Parameter(Mandatory = $true)]
  [string]$RepoDir,
  [Parameter(Mandatory = $true)]
  [string]$OutPath
)

$text = @"
WebCLI — что делать после установки
=====================================

Папка проекта:
  $RepoDir

----------------------------------------
1) CloudPub (HTTPS для телефона)
----------------------------------------
  • Зарегистрируйся: https://cloudpub.ru/dashboard
  • Открой НОВОЕ окно cmd и выполни:
      clo login
    (или: clo set token ТВОЙ_ТОКЕН из личного кабинета)

----------------------------------------
2) Ключи в .env
----------------------------------------
  Открой файл:
      notepad "$RepoDir\.env"

  Нужны две строки:
      AGENT_API_KEY=...   ← ключ Cursor: https://cursor.com/dashboard/integrations
      ACCESS_TOKEN=...    ← пароль для входа в веб-чат (любой свой)

  Cursor IDE / Cursor SDK отдельно ставить НЕ нужно:
  пакет @cursor/sdk ставится сам через npm install при setup.
  Нужен только API-ключ из дашборда Cursor (Integrations).

  Если ACCESS_TOKEN уже сгенерирован при setup — запомни его,
  им же входишь с телефона.

----------------------------------------
3) Запуск
----------------------------------------
  В проводнике открой папку проекта и запусти:
      start-phone.bat

  Или вручную два окна:
      start-prod.bat
      publish-release.bat

  • На компе:  http://127.0.0.1:8787
  • С телефона: HTTPS-ссылку, которую напечатает CloudPub
    (вид примерно https://что-то.cloudpub.ru)
  • Введи тот же ACCESS_TOKEN, что в .env

----------------------------------------
Важно
----------------------------------------
  • Оба окна держи открытыми, ПК не должен засыпать.
  • Первый голосовой ввод скачает модель Whisper (несколько ГБ).
  • Если clo / node / python «не найдены» — закрой cmd и открой новый.

Готово. Удачи.
"@

$utf8Bom = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($OutPath, $text.TrimStart() + "`r`n", $utf8Bom)
Write-Host "Wrote $OutPath"
