# ПриватБанк «Автоклієнт» (acp.privatbank.ua): создание исходящего платежа — отчёт

Дата: 2026-10-09. Сам банк и Google Docs через прокси недоступны (privatbank.ua, docs.google.com, habr.com, sudonull.com, web.archive.org дают 403 или DNS-ошибку). Поэтому источники такие: исходный код open-source клиентов (склонирован с GitHub, ниже ссылки) и сниппеты веб-поиска по официальному Google Doc «Опис API для взаємодії з серверною частиною Автоклієнта версія 3.0.0» (https://docs.google.com/document/d/e/2PACX-1vTtKvGa3P4E-lDqLg3bHRF6Wi9S7GIjSMFEFxII5qQZBGxuTXs25hQNiUU1hMZQhOyx6BNvIZ1bVKSr/pub).

Маркеры:
- **[V]** — подтверждено кодом из 2+ независимых репозиториев или дословной копией официального документа.
- **[V1]** — один источник с кодом.
- **[S]** — только пересказ из поискового сниппета (не дословно).
- **[U]** — не найдено, не проверено.

Основные источники:
- A. `sashalenz/privat24-business-api` (PHP, 1.1.0 от 2026-06, payments): https://github.com/sashalenz/privat24-business-api (src/ApiModels/Payments.php, src/RequestData/Payments/*, src/ResponseData/Payments/*, tests/Feature/PaymentsTest.php)
- B. `shpigunov/ua_banktools` (Python; create_payment с 2022-11, delete с 2026-07): https://github.com/shpigunov/ua_banktools/blob/main/ua_banktools/banks/privatbank/privatbank.py, …/types.py, tests/test_privatbank.py. Исходный коммит 2022 года: https://github.com/shpigunov/ua_banktools/commit/2c5377a199538dde94b16f41bbedba1127e91986
- C. `tsiparinda/capitalbank` (Go, в проде с 2024-06; ERP → банк): https://github.com/tsiparinda/capitalbank/blob/master/pbapi/sendpayment.go, https://github.com/tsiparinda/capitalbank/blob/master/store/models.go
- D. `DartVeyder/keycrm-panel` (PHP, в проде, возвраты покупателям): https://github.com/DartVeyder/keycrm-panel/blob/main/class/PrivatBankPayment.php, https://github.com/DartVeyder/keycrm-panel/blob/main/refund.php
- E. `Onix-Systems/python-privatbank-client` (Python; README содержит реальный ответ create_pred): https://github.com/Onix-Systems/python-privatbank-client/blob/main/README.md, …/privatbank_api_client/privat_config/config.py, …/privat_config/manager.py
- F. `yukal/privatbank-api-go` (Go, 2025-08): https://github.com/yukal/privatbank-api-go/blob/main/api_payment.go и README.md (повторяет оглавление официального документа)
- G. `Revent24/dino_odoo_erp` (дословная копия официального документа, только раздел выписок): https://raw.githubusercontent.com/Revent24/dino_odoo_erp/main/api_integration/services/privat_api.md
- H. `crnd-inc/privat24-autoclient` (Python, 2020, устарел, использует старый header `id`): https://github.com/crnd-inc/privat24-autoclient/blob/master/privat24_autoclient/api.py
- `ProzorroUKR/prozorro_tasks` (autoclient_payments) и `vplvua/fop-docs-app` **только читают выписки** (входящие платежи), платежи не создают. Для этой задачи они не нужны.

---

## 1. Эндпоинты

| Действие | Метод и URL | Маркер |
|---|---|---|
| Создать платёж | `POST https://acp.privatbank.ua/api/proxy/payment/create` | **[V]** (A, B, C, D) |
| Создать платёж «з прогнозом» (с предварительной проверкой) | `POST https://acp.privatbank.ua/api/proxy/payment/create_pred` | **[V]** (D, E, H, плюс сниппет оф. дока) |
| Получить платёж / статус | `GET https://acp.privatbank.ua/api/proxy/payment/get?ref=<payment_ref>` | **[V]** (A и F независимо) |
| Удалить неподписанный платёж | `POST https://acp.privatbank.ua/api/proxy/payment/delete?ref=<payment_ref>`, пустое тело, ответ 204 | **[V]** (A и B, оба 2026 года) |
| Пакет/batch обычных платежей | **не найдено** **[U]**. Для массовых выплат есть отдельный зарплатный API `pay/maspay/create`, `/add`, `/validate`… (A, README). Он адресует людей по ID из справочника банка, а не по IBAN | [V1] |
| Загрузка подписанного платежа (подпись через API) | Раздел в оф. доке есть («4.1 Завантаження підписаного платежу»), **точный URL не найден** **[U]** | [S] |

Цитаты:
- C, `sendpayment.go`: `url := "https://acp.privatbank.ua/api/proxy/payment/create"` / `req, err := http.NewRequest("POST", url, ...)`
- D, `PrivatBankPayment.php`: `private const BASE_URL = 'https://acp.privatbank.ua/api/proxy/payment';` `URL_CREATE = '/create'; URL_CREATE_PRED = '/create_pred';` Там же комментарий: «Створення платежу з прогнозом. URL: https://acp.privatbank.ua/api/proxy/payment/create_pred»
- F, `api_payment.go`: `apiURL := buildApiURL("/proxy/payment/get", params)` с `params.Add("ref", paymentRef)`, вызов через `a.httpAgent.Get`
- A, `Payments.php`: «Delete an unsigned payment document. The API expects POST with the ref in the query string and an empty body, and answers 204 No Content»
- B, тест: `"https://egress.example/privat/proxy/payment/delete", ... params={"ref": "payment-ref"}`
- Сниппет оф. дока [S]: в документе два варианта, «створення з прогнозом (`/api/proxy/payment/create_pred`) і без прогнозу (`/api/proxy/payment/create`)»

Разница `create` и `create_pred`: в ответе на `create_pred` (E) есть `"checked_on_pred": "true"`, то есть платёж прошёл предварительную проверку банком. Точную семантику («прогноз») подтвердить не удалось **[U]**. Для обычного IBAN-платежа и A, B, C используют `create`. D в проде использует `create_pred`.

### Заголовки
Те же, что для выписок: `User-Agent`, `token`, `Content-Type: application/json;charset=utf8` **[V]** (A, B, D; G для всего API).

⚠️ **Кодировка.** Дословно из оф. дока (G): «Content-Type – application/json;charset=cp1251. Підтримувані кодування utf8 і cp1251. **Якщо charset не зазначено, кодування за замовчуванням cp1251.**» **[V]**
Отсюда вывод: в Node обязательно явно передавать `;charset=utf8`, иначе кириллица в `payment_naming`/`payment_destination` испортится. C отправляет `Content-Type: application/json` без charset и поэтому сам перекодирует тело в CP-1251 (`utils.ConvertToCP1251`, коммит «first test payments», 2024-06-07). A специально сохраняет `application/json;charset=utf8` для POST: в CHANGELOG 1.1.0 записано «asJson() was silently overriding it».

---

## 2. Тело запроса (JSON). Все значения — строки

D: «Згідно документації: "Усі реквізити типу string"». То же даёт сниппет оф. дока [S].

### Обязательные поля **[V]** (A, B, C, D, E одинаково)
| Поле | Смысл | Формат / пример |
|---|---|---|
| `document_number` | номер документа | строка, например `"42"`, `"AC12345"` (D), `"autoclient"` (E) |
| `payer_account` | IBAN плательщика (ваш счёт) | `"UA77305299..."` |
| `recipient_account` | IBAN получателя | `"UA74305299..."`. Альтернатива: `recipient_card` (номер карты). Передавать оба поля одновременно нельзя (см. ошибки) |
| `recipient_nceo` | ЄДРПОУ / РНОКПП получателя | `"12345678"` / `"1234567890"` |
| `payment_naming` | наименование получателя | `"ТОВ \"Отримувач\""` |
| `payment_amount` | сумма | **строка с точкой**, 2 знака: `"1250.50"` |
| `payment_destination` | назначение платежа | строка |

Сниппет оф. дока [S]: «Обов'язкові реквізити: document_number – номер документа; payer_account – рахунок відправника; recipient_account – рахунок одержувача (або recipient_card для ...». Также оттуда: «recipient_nceo — ЄДРПОУ одержувача, payment_naming — назва одержувача, payment_destination — призначення платежу».

Нюансы:
- Сумма: B — `payment_amount=f"{Decimal(str(amount)):.2f}"`. В 2022 году там был float, в 2026-07 перешли на строку. A — `'regex:/^\d+(\.\d{1,2})?$/'` и комментарий «The API expects a decimal string ('1234.56'); zero is rejected by the bank». **[V]**
- `recipient_nceo` для физлица без кода: A пишет «'0000000000' for individuals without one». **[V1, не подтверждено документом]** H (2020) также требует `recipient_ifi`. Современные клиенты A, B, C его не требуют.
- Длина `payment_destination`: A проверяет `'min:5', 'max:420'` **[V1]**. Сниппет говорит, что в оф. доке есть ограничения длины и для платежей в бюджет (МФО 899998) лимит короче. Точных чисел не найдено **[S/U]**.

### Необязательные поля
Полный список полей запроса из C (`store/models.go`, JSON-теги), явно скопирован из оф. дока **[V1]**. Большинство подтверждает список `fields_for_sign` в реальном ответе банка (E) **[V]**:
```
document_type            // E/D: "cr" (дефолт по сниппету оф. дока [S])
payment_date             // дата списания, "дд.мм.гггг" (D: date('d.m.Y'); сниппет: пример "04.09.2017"); если нет — текущая [S]
payment_accept_date      // дата зачисления/валютирования, "дд.мм.гггг" (D)
payment_ccy              // "UAH" (D, E)
payment_cb_ref, copy_from_ref, attach, signer_msg, odb_msg   (C, H)
recipient_ifi            // МФО банка получателя, напр. "305299" (C, E, H)
recipient_ifi_text       // название банка получателя (C, E, H)
recipient_card           // вместо recipient_account
payer_ultmt_nceo, payer_ultmt_name, payer_ultmt_document_series,
payer_ultmt_document_number, payer_ultmt_document_id_number         // конечный плательщик
recipient_ultmt_nceo, recipient_ultmt_name, recipient_ultmt_document_series,
recipient_ultmt_document_number, recipient_ultmt_document_id_number // конечный получатель
struct_code, struct_category, struct_type   // структурированное назначение налогового платежа
```
В `fields_for_sign` из E есть ещё `recipient_document_series`, `recipient_document_number`, `recipient_document_id_number`, `recipient_country_code` **[V1]**. Их назначение не описано.

**Налоговые/бюджетные платежи.** Поля запроса `struct_code`, `struct_type`, `struct_category` (нижний регистр) есть в C и в `fields_for_sign` (E) **[V]**. Их смысл берём из одноимённых полей выписки в оф. доке (G, дословно) **[V для выписки; перенос смысла на запрос — вывод]**:
```
"STRUCT_CODE":"101",       // код виду сплати
"STRUCT_TYPE":"22080000",  // код бюджетної класифікації
"STRUCT_CATEGORY":"Довільний текст" // Інформація про податкове повідомлення (рішення)
```
Формат назначения платежа для бюджета (`*;101;…`) и обязательность struct_* в API не найдены **[U]**.

---

## 3. Ответ

### Создание (HTTP 201) **[V]**
Минимум (A, B 2026, C):
```json
{ "payment_ref": "1123828417658092296", "payment_pack_ref": "..." }
```
C, `models.go`: `PaymentRef string json:"payment_ref" // "референс створеного платежу"`, `PaymentPackRef string json:"payment_pack_ref" // "запакований референс створеного платежу"`. Комментарии на украинском, похоже, взяты из оф. дока.

Полный реальный ответ `create_pred` (E, README, значения замаскированы автором):
```json
{
  "payment_data": {
    "can_copy": "1", "can_edit": "1", "checked_on_pred": "true",
    "document_number": "autoclient", "document_type": "cr",
    "fields_for_sign": { "fields": ["payment_ref","user_id","document_type","document_number","payer_account","payment_accept_date","recipient_account","recipient_card","recipient_nceo","payment_naming","payment_amount","payment_destination","payment_ccy", "...", "struct_code","struct_category","struct_type"], "version": "v3.4.0" },
    "id": "xxxxxxxxxxxxxxxxxxx", "internal_type": "card",
    "level_sign": { "1_sign_level": "false" },
    "payer_account": "UA…", "payer_bank_name": "АТ КБ \"ПРИВАТБАНК\"", "payer_name": "ФОП …", "payer_nceo": "…",
    "payment_amount": "0.01", "payment_ccy": "UAH", "payment_date_unix": "…",
    "payment_destination": "test create pmnt to rest API", "payment_naming": "ПАО, ПАО КБ ПРИВАТБАНК",
    "payment_ref": "xxxxxxxxxxxxxxxxxxx", "payment_sign": [],
    "payment_status": "new", "payment_status_short": "n",
    "recipient_card": "…", "recipient_nceo": "…", "service_update_utime": "…",
    "source": "aup", "tabs": ["all","saved"], "user_id": "…"
  },
  "payment_pack_ref": "xxxxxxxxxxxx",
  "payment_ref": "xxxxxxxxxxxxxxxxxxx"
}
```
Обёртка `payment_data` + `payment_pack_ref` + `payment_ref` есть и в B 2022 года (`class PaymentCreateSuccessResponse: payment_data: PaymentData; payment_pack_ref: str; payment_ref: str`) **[V]**. Там же `PaymentData` содержит `payment_date`, `payment_accept_date`, `payment_status`, `level_sign`, `internal_type`, `source`, `can_edit`, `can_copy`.

### Получение (`proxy/payment/get?ref=`)
A, мок теста: `{ "payment_ref": "...", "payment_status": "new", "document_number": "test", "payment_amount": "1.02", "level_sign": {"1_sign_level": false, "2_sign_level": false}, "fields_for_sign": {"version": "v3.5.0", "fields": ["payment_ref"]} }` **[V1]**. A пишет: «the API returns the full payment document (plus signature metadata like level_sign / fields_for_sign)». Обёртка ответа `get` (есть ли `payment_data`) не подтверждена **[U]**: F возвращает сырой `http.Response`.

### Статусы
- `payment_status: "new"`, `payment_status_short: "n"` для только что созданного **[V]** (E, A).
- Полный словарь статусов **не найден** **[U]**. A: «Known payment_status values: 'new' (awaiting signature). The full vocabulary is not published». В выписке есть `PR_PR` (из G: p — проводиться, t — сторнована, r — проведена, n — забракована), но это статус проводки в выписке, а не платёжного документа.
- `level_sign` показывает, какие уровни подписи наложены (`1_sign_level`, `2_sign_level`) **[V]**.

### Связь с выпиской (DLR)
- Оф. док (G, дословно) **[V]**: `"DLR": "J63DNDSM0XHY5", // референс платежу сервісу, через який створювали платіж (payment_pack_ref - у разі створення платежу через АPI «Автоклієнт»)`. Тот же комментарий в F (`PaymentRef string json:"DLR"`) и в A (`Types/Transaction.php`).
- Значит, сверку проведённого дебета нужно делать по **`DLR == payment_pack_ref`**. C в проде сохраняет именно `rsp.PaymentPackRef` как `ref_num` для последующей сверки.
- `payment_ref` используется для `get` и `delete`. Источники противоречат друг другу: README в A говорит «payment_ref — він же REF у виписці після проведення», а докблок в том же A — «payment_ref … does NOT appear in the statements feed». Не полагайтесь на `payment_ref` для сверки **[U]**.
- E показывает строку выписки API-платежа после проведения: `"NUM_DOC": "autoclient"` (это наш `document_number`), `"DOC_TYP": "p"`, `"DLR": "xxx/xxxxxxxx"` (замаскировано, формат со слэшем). Запасной ключ сверки: `NUM_DOC` + сумма + счёт **[V1]**.

---

## 4. Жизненный цикл и подпись

- Созданный через API платёж **не двигает деньги**. Он появляется в «Приват24 для бізнесу» как черновик со статусом `new` и ждёт подписи КЕП **[V]**:
  - A, `Payments.php`: «A payment created via the API does NOT move money: it lands in Privat24 for Business with status "new" and waits for a KEP signature in the cabinet. Until signed it can be deleted via delete().»
  - A, `CreatePaymentRequest.php`: «money does not move until an authorized person signs it with their KEP in the cabinet.»
  - Хабр «Управление платежами в Приват24 из Google-таблиц» (https://habr.com/ru/articles/354214/), сниппет [S]: «автоклиент не влияет на движение денежных средств, а лишь создаёт черновик документа».
  - Ответ E: `"payment_sign": []`, `"level_sign": {"1_sign_level": "false"}`, `"payment_status": "new"`.
- **Подпись через API в принципе предусмотрена**, но готовой реализации ни в одном open-source клиенте нет **[S/U]**:
  - В оглавлении оф. дока (повторено в F README) есть «Створення платежу → Завантаження підписаного платежу» (`[NOT IMPLEMENTED] Uploading a signed payment`). Отдельно для ЕДО есть «Отримання Base64-документа (для підписання)».
  - Сниппеты оф. дока [S]: раздел «4.1 Завантаження підписаного платежу». Подпись накладывается на JSON с полями из `fields_for_sign` (поле версии v3.4.0/v3.5.0). В поле `sign` передаётся BASE64 подписанных данных. Принимается только КЕП (CAdES-T / BES / X-Long, пример — SmartID). Загружать нужно токеном того пользователя, чья подпись: «для завантаження платежу з підписом директора - необхідно використовувати авторизаційний токен директора, а для … бухгалтера - авторизаційний токен бухгалтера».
  - **URL эндпоинта загрузки подписи и точная схема тела не найдены** **[U]**. Для Cloud Function практический вывод такой: создаём платёж через API, подписывает человек в Приват24 для бізнесу (или через мобильное приложение, если банк это допускает), функция затем опрашивает `get` и выписку.
- Удаление возможно только до подписания. A: «Delete an unsigned payment document». B: «Delete a created payment while it is still eligible for deletion». Ошибка при невозможности удаления в тесте B: `serviceCode: "PMTMDL004"`, `"message": "Payment cannot be deleted"` (тестовая фикстура, не реальный ответ) **[V1]**.

---

## 5. Права токена, лимиты, ошибки

- **Отдельное право «создание платежей» для токена.** Подтверждения не найдено **[U]**. Найдено только следующее [S]: при генерации Автоклієнта выбирают пользователя и «рівень доступу» (по пересказу инструкции Torgsoft, «три рівні», названия не приведены) и «Доступні рахунки». Офиц. страница https://privatbank.ua/business/intehratsiya перечисляет среди возможностей API «створювати платежі в Приват24 для бізнесу». Путь: Приват24 для бізнесу → Облік та звіти / Каталог → Інтеграція (Автоклієнт) → Підключити додаток → API. Токен привязан к пользователю, отсюда правило «токен директора / токен бухгалтера» для подписи. Скорее всего, пользователь токена должен иметь в кабинете право создавать платежи по счёту `payer_account`. Это вывод, а не цитата.
- **Лимиты частоты для payment API** не найдены **[U]**. Лимиты длины: `payment_destination` ≤ 420 (A) [V1], для бюджета короче [S].
- **Формат ошибки** **[V]** (B, C, D):
  ```json
  { "status": "ERROR", "code": 400, "message": "invalid document number",
    "requestId": "20240223_131617_286f", "serviceCode": "PMTSRV0112" }
  ```
  Источник — C, `models.go`: `ResponseCode int64 json:"code" // 201 or 400`, `ResponseMessage … //"invalid document number"`, `ResponseRequestId … // "20240223_131617_286f"`, `ResponseServiceCode … // "PMTSRV0112"`. B: `status, code, message, requestId, serviceCode`. D: «PMTMDL0016 - "Вказано одночасно і картку та рахунок одержувача"».
  HTTP-коды из H (2020): 400 — неверный формат или нет заголовков, 401 — неверные креды, 403 — Автоклієнт отключён в кабинете, 500/502 и 503/504 — ошибки сервера.

---

## 6. Рабочие примеры из open-source

**D (прод, PHP, `refund.php`), тело запроса:**
```php
$paymentData = [
  "document_number"     => "AC{$orderId}{$docSuffix}",
  "payer_account"       => $cfg['my_iban'],
  "recipient_account"   => $iban,
  "recipient_nceo"      => $edrpou,
  "payment_naming"      => $buyer,
  "payment_amount"      => $amount,
  "payment_destination" => "Повернення коштів за повернений товар замовлення {$orderId}",
  "payment_ccy"         => "UAH",
  "document_type"       => "cr",
  "payment_date"        => $today,          // date('d.m.Y')
  "payment_accept_date" => $today,
];
$result = $api->createWithForecast($paymentData);   // POST .../proxy/payment/create_pred
if (!empty($result['payment_ref'])) { ... }
```
Заголовки D: `'Content-Type' => 'application/json;charset=utf-8'`, `'token' => $this->token`, `'User-Agent' => 'PrivatBank-Autoclient-PHP'`. Тело: `json_encode(..., JSON_UNESCAPED_UNICODE)`, все значения приводятся к `(string)`.

**B (Python), тест на точное тело:**
```python
POST .../proxy/payment/create
json={"document_number": "42", "payer_account": "UA94…", "recipient_account": "UA94…",
      "recipient_nceo": "14360570", "payment_naming": "Counterparty",
      "payment_amount": "1.20", "payment_destination": "Test payment"}
→ {"payment_ref": "payment-ref", "payment_pack_ref": "payment-pack-ref"}
```

**Набросок для Node 22 (fetch) по найденному.** Это вывод из источников, на реальном банке не проверен:
```js
const H = { 'User-Agent': 'MyApp', token: process.env.PB_TOKEN,
            'Content-Type': 'application/json;charset=utf8' };
// create
const r = await fetch('https://acp.privatbank.ua/api/proxy/payment/create', {
  method: 'POST', headers: H,
  body: JSON.stringify({ document_number: '42', payer_account: 'UA…', recipient_account: 'UA…',
    recipient_nceo: '12345678', payment_naming: 'ТОВ "Отримувач"', payment_amount: '1250.50',
    payment_destination: 'Оплата згідно рахунку №42', payment_ccy: 'UAH', document_type: 'cr',
    payment_date: '09.10.2026' }) });
// 201 → { payment_ref, payment_pack_ref, payment_data? }; ошибка → { status:'ERROR', code, message, requestId, serviceCode }
// status
await fetch(`https://acp.privatbank.ua/api/proxy/payment/get?ref=${encodeURIComponent(ref)}`, { headers: H });
// delete (только пока не подписан): POST, ref в query, БЕЗ тела, 204
await fetch(`https://acp.privatbank.ua/api/proxy/payment/delete?ref=${encodeURIComponent(ref)}`, { method: 'POST', headers: H });
// сверка: в /api/statements/transactions искать TRANTYPE "D" с DLR === payment_pack_ref
```

---

## Итог: что не найдено / не подтверждено
1. URL и схема загрузки подписанного платежа (подпись через API). Раздел в оф. доке есть, эндпоинт неизвестен.
2. Пакетное создание обычных платежей. Отдельного «pack create» не найдено; есть только зарплатные реестры `pay/maspay/*`.
3. Полный словарь `payment_status`. Известен только `new`/`n`.
4. Есть ли у токена отдельное право на платежи и как оно называется. Лимиты частоты.
5. Точная семантика `create_pred` и формат назначения платежа для бюджета (обязательность `struct_*`).
6. Точная обёртка ответа `proxy/payment/get`.
