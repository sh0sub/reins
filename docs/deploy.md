# Render 배포 (#38 D11)

저장소 루트의 `render.yaml`(Render Blueprint) 하나로 무료(Free) 웹 서비스 2개를 만든다. 할 일은 Render 계정 만들기, Blueprint 연결, 비밀값 붙여넣기, 배포 뒤 웹훅 2개 등록이다. 요금은 ₩0이다.

| 서비스 | 종류 | 하는 일 |
|---|---|---|
| `reins-web` | Web (Free, 디스크 없음) | 대시보드 + REST API + PayPal/Telegram 웹훅. SQLite 파일 `/tmp/reins.db` |
| `reins-mcp` | Web (Free) | MCP Streamable HTTP (`POST /mcp`). 공개 URL(`REINS_API_URL=https://reins-web.onrender.com`)로 `reins-web` 호출. 무료 인스턴스는 사설망을 못 쓴다 |

크론 잡은 없다(Render에서 유료). DevOps 데모 에이전트와 reconcile은 [수동 실행](#수동-실행)으로 돌린다.

## DB: /tmp의 SQLite (무료 플랜)

계획서(D11)에는 Postgres라고 적혀 있지만 SQLite(libsql 파일)를 `/tmp`에 두기로 했다.

- 무료이고 만료되지 않는다. 따로 띄울 서비스도 없고, 코드도 로컬과 같은 경로를 탄다(`DATABASE_URL=file:/tmp/reins.db`).
- 부팅할 때마다 `/tmp`가 비어 있어서 시드(`seed.ts --if-empty`)가 데모 상태(에이전트 3개, 녹화된 실제 샌드박스 실행 15건, $43.95 / $410.00)를 새로 넣는다. 심사위원이 보는 데모는 항상 깨끗하게 시작한다.
- 대신 생기는 제약: 무료 인스턴스는 15분쯤 요청이 없으면 잠들고, 깨어나는 데 약 1분 걸린다. 잠들거나 재배포하면 `/tmp`가 지워져서 그동안 만든 에이전트·키·승인 기록이 사라진다. 녹화 데모나 라이브 심사 직전에는 요청을 한 번 보내 먼저 깨워 둔다(예: `curl -sS $WEB/api/health`). 에이전트와 키는 깨운 뒤에 만든다.

## 1. Render 계정과 Blueprint

1. https://dashboard.render.com 에서 GitHub로 가입하고 이 저장소 접근 권한을 준다.
2. **New → Blueprint** → 저장소 선택 → 브랜치 `main`. Render가 `render.yaml`을 읽어서 무료 서비스 2개를 보여준다.
3. `sync: false`인 변수들의 값을 묻는 화면이 나온다. 아래 표대로 넣는다. 지금 모르는 값(`PAYPAL_WEBHOOK_ID`, `REINS_API_KEY`)은 비워 두고 배포 뒤에 채운다. 이 화면은 처음 만들 때 한 번만 나온다. 나중에 바꿀 때는 각 서비스의 **Environment** 탭을 쓴다.
4. **Apply**를 누른다. 유료 인스턴스는 없다(전부 Free 플랜, ₩0).
5. 첫 배포가 끝나면 `reins-web`이 빈 DB에 데모 데이터를 한 번 넣는다(에이전트 3개, 녹화 실행 15건, "This month $43.95 of $410.00"). 같은 부팅 안에서는 에이전트가 하나라도 있으면 다시 넣지 않는다(`seed.ts --if-empty`, `--force`는 절대 쓰지 않음).

서비스 주소는 보통 `https://reins-web.onrender.com`, `https://reins-mcp.onrender.com`이다. 이름이 이미 쓰이고 있으면 Render가 `reins-web-xxxx`처럼 접미사를 붙이므로 대시보드에 나온 실제 주소를 쓴다. 앱은 `PUBLIC_BASE_URL`이 없으면 Render가 넣어 주는 `RENDER_EXTERNAL_URL`을 쓰기 때문에 주소를 직접 적을 필요는 없다.

## 2. 붙여넣을 환경변수 (값은 절대 저장소에 쓰지 않는다)

### reins-web

| 변수 | 필수 | 어디서 가져오나 |
|---|---|---|
| `PAYPAL_CLIENT_ID` | 권장 | developer.paypal.com → Apps & Credentials → **Sandbox** 앱 → Client ID. 비우면 가짜 PayPal(fake)로 돈다 |
| `PAYPAL_CLIENT_SECRET` | 권장 | 같은 화면의 Secret |
| `PAYPAL_WEBHOOK_ID` | 배포 뒤 | 3단계에서 웹훅을 등록하면 나오는 Webhook ID. 없으면 웹훅 서명 검증이 실패한다 |
| `PAYPAL_SANDBOX_MERCHANT_EMAIL` | 선택 | 샌드박스 비즈니스 계정 이메일(developer.paypal.com → Testing Tools → Sandbox Accounts). Setup의 "Use demo merchant"에 표시된다 |
| `TREASURY_PAYEE_EMAIL` | 필수(treasury 모드) | 받는 쪽 샌드박스 개인 계정 이메일. Render 대시보드에서 직접 입력한다(저장소에 쓰지 않음). 없으면 서버가 경고를 남기고 supervised로 동작한다(실패한 결제는 생기지 않음) |
| `ANTHROPIC_API_KEY` | 권장 | console.anthropic.com → API Keys. 비우면 결정적 mock 심사기 |
| `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` | 선택 | AG Grid Enterprise 키(체험판 키는 ag-grid.com 무료 신청). 비우면 공개 URL의 원장에 체험판 워터마크가 보인다. 빌드 때 읽으므로 넣은 뒤 재배포 |
| `TELEGRAM_BOT_TOKEN` | 선택 | BotFather에서 받은 토큰. 비우면 텔레그램 없이 웹 승인함만 쓴다 |
| `TELEGRAM_WEBHOOK_SECRET` | 텔레그램 쓸 때 | 직접 만든다: `openssl rand -hex 32`. 영문·숫자·`_`·`-`만 된다. 4단계 setWebhook에 같은 값을 넣는다 |

`render.yaml`에 이미 들어 있어서 넣을 필요 없는 값: `DATABASE_URL=file:/tmp/reins.db`, `PAYPAL_ENV=sandbox`, `PAYPAL_PAYMENT_MODE=treasury`(승인된 /try 요청이 구매자 로그인 없이 실제 샌드박스 Payouts로 지급되고, 앱이 payout 조회와 `PAYMENT.PAYOUTS-ITEM.*` 웹훅으로 정산한다. `TREASURY_PAYEE_EMAIL`이 필요하다), `REINS_TIMEZONE=Asia/Seoul`, `REINS_QUIET_HOURS=off`(심사위원 시간대 때문에 공개 데모에서는 끔), `REINS_PUBLIC_DEMO=1`(방문자 PayPal 키 입력 차단, 데모 판매자만 연결), `REINS_APPROVAL_TTL_MINUTES=10080`(7일. 심사 기간 내내 시드된 승인 카드가 만료되지 않게), `TELEGRAM_BOT_USERNAME=ReinsApproveBot`(봇 이름이 다르면 Environment 탭에서 고친다), `NODE_VERSION=22`, `REINS_CRON_SECRET`(Render가 자동 생성. 크론과 공유하지 않고, 수동 reconcile 호출에만 쓴다. 값은 `reins-web` Environment 탭에서 본다).

`NODE_ENV`는 일부러 넣지 않았다. Render가 실행할 때만 `production`으로 설정한다. 빌드 때도 `production`이면 pnpm이 devDependencies(typescript, tsx)를 건너뛰어서 빌드와 시드가 깨진다.

`REINS_ADMIN_TOKEN`도 넣지 않는다. 넣으면 대시보드 API가 토큰을 요구해서 심사위원이 데모를 볼 수 없다. 공개 데모는 누구나 승인·거절할 수 있는 열린 모드다.

`reins-mcp`의 `REINS_API_URL`(`https://reins-web.onrender.com`)은 `render.yaml`에 들어 있다. Render가 다른 서브도메인을 줬으면(`reins-web-xxxx`) `reins-mcp` → Environment에서 실제 주소로 고친다.

## 3. PayPal 웹훅 등록

1. developer.paypal.com → Apps & Credentials → Sandbox → Reins 앱 → **Webhooks → Add Webhook**.
2. Webhook URL: `https://<web>.onrender.com/api/webhooks/paypal` (예: `https://reins-web.onrender.com/api/webhooks/paypal`)
3. 이벤트 10개를 체크한다(`packages/core/src/webhooks.ts`의 `SUBSCRIBED_EVENTS`와 같다):
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.DECLINED`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.BLOCKED`, `PAYMENT.PAYOUTS-ITEM.RETURNED`, `PAYMENT.PAYOUTS-ITEM.DENIED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`
   - 이미 등록한 웹훅(`1RG081878V566513K`)에는 `PAYMENT.PAYOUTS-ITEM.DENIED`가 빠져 있다. 추가를 권장한다(없어도 payout 조회가 정산하므로 동작은 한다). `PAYOUTSBATCH.*` 이벤트는 필요 없다.
4. 저장한 뒤 나온 **Webhook ID**를 `reins-web` → Environment → `PAYPAL_WEBHOOK_ID`에 넣고 저장한다(자동으로 재배포된다).

## 4. Telegram 웹훅 (봇을 쓸 때만)

PUBLIC URL이 https라서 앱은 자동으로 웹훅 모드가 된다(롱 폴링 안 함). 웹훅 등록은 한 번만 하면 된다. 아래 명령은 내 터미널에서 실행하고, 값은 직접 바꿔 넣는다. 토큰이 셸 기록에 남지 않게 앞에 공백을 하나 붙인다.

```bash
 curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<web>.onrender.com/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET과 같은 값>"
 curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"   # url과 pending_update_count 확인
```

그다음 `https://<web>/setup` 3단계 **Link Telegram**을 눌러 열린 봇 채팅에서 Start를 눌러 연결한다(서버의 `.local/telegram-chat-id.txt`는 Render에 없다).

주의: 같은 봇 토큰으로 로컬 `pnpm dev:web`을 http 주소로 띄우면 롱 폴링이 시작되면서 웹훅을 지운다. 로컬에서는 `.env`에 `TELEGRAM_MODE=off`를 두거나, 로컬 작업 뒤 위 setWebhook을 다시 실행한다.

## 5. 확인 (smoke check)

```bash
WEB=https://reins-web.onrender.com     # 실제 주소로 바꾼다
MCP=https://reins-mcp.onrender.com

curl -sS $WEB/api/health                 # {"ok":true}  (DB 열기와 마이그레이션까지 확인됨. 잠든 뒤 첫 요청은 ~1분 걸린다)
curl -sS "$WEB/api/health?detail=1"      # payment_mode, treasury_payee_configured (true/false만 나온다. 값은 안 나옴)
curl -sS $WEB/api/overview | head -c 300 # "totals":{"spent_cents":4395,"limit_cents":41000,"agents":3,...}
curl -sS $MCP/health                     # ok

# MCP tools/list: 배포 뒤 /agents에서 만든 에이전트 키 (rk_live_...)
 curl -sS -X POST $MCP/mcp \
  -H "Authorization: Bearer rk_live_..." \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# -> get_mandate, request_purchase, get_request_status, list_transactions

curl -sS -o /dev/null -w "%{http_code}\n" -X POST $WEB/api/cron/reconcile   # 401 (비밀값 없이는 막힘)
```

그 밖에:

- 브라우저로 `$WEB/overview`, `$WEB/setup`을 연다. Setup 1단계 **Use demo merchant (sandbox)** 를 누르면 서버의 샌드박스 자격증명으로 연결된다. 심사위원은 자기 PayPal 키 없이 전체 흐름을 볼 수 있다.
- **공개 데모의 PayPal 표시** (PayPal 키가 있을 때): 부팅 시드가 워크스페이스를 `paypal_env=sandbox`로 연결한다(판매자 이메일은 `PAYPAL_SANDBOX_MERCHANT_EMAIL`, 없으면 데모 주소). 서버가 실제로 쓰는 클라이언트(`HttpPayPalClient`, 샌드박스)와 같게 사이드바·헤더는 **PayPal Sandbox**, `/api/try` 응답은 `"paypal":"sandbox"`. 키가 없거나 `PAYPAL_ENV=fake`면 지금처럼 **Simulated PayPal**(`pnpm judge`는 항상 fake). 시드된 이력은 녹화된 실제 샌드박스 실행이다(실제 batch·transaction id, 모든 행에 "recorded run" 칩과 툴팁에 실제 녹화 시각·이동값). `pnpm judge`·`PAYPAL_ENV=fake`에서도 시드 원장은 같지만 새 요청만 가짜 PayPal(SIM id)과 오프라인 심사기를 쓴다.
- **/try 결과 (treasury)**: 승인된 요청은 실제 샌드박스 payout으로 지급된다(구매자 로그인 없음). PayPal이 UNCLAIMED로 보고하면 "Payout unclaimed"로 보이고 실패가 아니라 확정(committed) 상태다. `TREASURY_PAYEE_EMAIL`이 없어 supervised로 떨어졌다면: 승인된 요청은 실제 샌드박스 주문이 만들어지고 `awaiting_buyer`에서 멈춘다. 실패가 아니라 "Approved by Reins — real PayPal sandbox order … created. Buyer approval on PayPal is the last step"으로 보이고, 주문 id와 PayPal 샌드박스 승인 링크가 나온다. "Five $29 orders"는 하드 룰상 앞 3건 통과, 4·5번째는 같은 판매자 합계로 거절된다. 호스팅의 실제 Claude 심사기가 앞 3건 중 일부를 분할 주문으로 보고 직접 거절하거나 사람 승인으로 올릴 수 있다.
- **Ledger "Reconcile now" (공개 데모 + 샌드박스)**: 창 안의 완료 결제가 모두 시드(녹화 실행 행 또는 `SIM-` id)면 Transaction Search를 부르지 않고 중립 안내만 보인다(mismatch 배너 없음, 아무 행도 안 바뀜). /try 주문을 PayPal에서 승인·캡처한 진짜 결제가 있으면 그것만 실제로 대사하고, 녹화·시드 행은 건너뛴다(배너에 "N seeded demo payments left as seeded"). 크론 `/api/cron/reconcile`도 실제 PayPal 워크스페이스에서는 시드 행을 건너뛴다.
- 아래 [수동 실행](#수동-실행)의 두 명령을 한 번씩 돌려 본다. devops는 "Infra cost check: ..."를, reconcile은 `{"window":...,"checked":...}`(건수만)를 찍는다.
- Claude Code에서 HTTP MCP로 붙이기: `claude mcp add --transport http reins $MCP/mcp --header "Authorization: Bearer rk_live_..."`.

## 운영 메모

- **데모 데이터 다시 넣기**: 시드는 녹화된 실행(`scripts/demo/fixtures/real-sandbox-run.json`)을 재생하며, 시각은 녹화 종료가 부팅 약 3분 전이 되도록 한 번에 이동된다. 달이 바뀌거나 대기 승인 항목이 만료되면(30분) 데모 녹화 직전에 다시 넣는다. `reins-web` → **Shell**에서 실행: `cd apps/web && node --import tsx ../../scripts/seed.ts --db "$DATABASE_URL"`. 직접 만든 에이전트 같은 다른 데이터가 있으면 거부하는데, 그때는 끝에 `--force`를 붙인다(시드 행만 바뀐다).
- **처음부터 다시**: `reins-web`에서 Manual Deploy를 하거나 15분 뒤 잠들 때까지 기다린다. 어느 쪽이든 `/tmp`가 비워지고 다음 부팅 때 데모 상태로 다시 시드된다.
- **로그**: 비밀값·이메일은 찍지 않는다. reconcile은 건수만, Telegram 로그는 `REINS_TELEGRAM_LOG=1`일 때 카드 첫 줄만 남긴다.
- 서비스 2개는 공개 URL로 통신하므로 region이 같을 필요는 없지만, 지연을 줄이려고 둘 다 `oregon`에 둔다.

## 수동 실행

크론 잡이 없으므로 아래 두 가지는 필요할 때 내 터미널에서 직접 실행한다. 먼저 `$WEB`에 요청을 보내 인스턴스를 깨운다.

```bash
# DevOps 데모 에이전트 B (키는 배포된 /agents에서 "Claude Code - DevOps"를 만들어 받은 rk_live_...; 시드 키는 쓸 수 없다)
REINS_MCP_URL=https://reins-mcp.onrender.com/mcp REINS_API_KEY=rk_live_... pnpm agent:devops

# PayPal Transaction Search 대사 (REINS_CRON_SECRET은 reins-web Environment 탭에서 복사)
curl -X POST -H "Authorization: Bearer $REINS_CRON_SECRET" https://reins-web.onrender.com/api/cron/reconcile
```

잠들면 에이전트와 키가 사라지므로(위 DB 절 참고) 에이전트를 만든 직후에 실행한다.
