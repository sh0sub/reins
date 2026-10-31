# Render 배포 (#38 D11)

저장소 루트의 `render.yaml`(Render Blueprint) 하나로 서비스 4개를 만든다. 할 일은 Render 계정 만들기, Blueprint 연결, 비밀값 붙여넣기, 배포 뒤 웹훅 2개 등록이다.

| 서비스 | 종류 | 하는 일 |
|---|---|---|
| `reins-web` | Web (0.5c-512mb, 디스크 1GB `/var/data`) | 대시보드 + REST API + PayPal/Telegram 웹훅. SQLite 파일 `/var/data/reins.db` |
| `reins-mcp` | Web (0.5c-512mb) | MCP Streamable HTTP (`POST /mcp`). Render 사설망으로 `reins-web` 호출 |
| `reins-devops-cron` | Cron, 매일 00:00 UTC (09:00 KST) | 데모 에이전트 B. `reins-mcp`에 MCP로 접속해 소액 인프라 청구서 결제 요청 |
| `reins-reconcile-cron` | Cron, 매일 18:30 UTC (03:30 KST) | PayPal Transaction Search 대사. `reins-web`의 `POST /api/cron/reconcile`을 curl로 호출 |

## DB: Postgres 대신 디스크의 SQLite

계획서(D11)에는 Postgres라고 적혀 있지만 SQLite(libsql 파일)를 Render 영구 디스크에 두기로 했다.

- 인스턴스가 하나뿐이라 동시 쓰기 문제가 없다. 디스크를 붙인 서비스는 확장(scale)이 안 되는데, 데모에는 확장이 필요 없다.
- Render 무료 Postgres처럼 만료되지 않고, 따로 띄울 서비스도 없다. 코드도 로컬과 같은 경로를 탄다(`DATABASE_URL=file:/var/data/reins.db`).
- 대신 생기는 제약: 디스크는 `reins-web`만 쓸 수 있다. 그래서 Cron은 DB를 직접 열지 않고 웹 엔드포인트를 호출한다. 디스크가 있으면 무중단 배포가 안 돼서 재배포 때 몇 초간 응답이 끊긴다. 빌드·pre-deploy 단계에서는 디스크가 마운트되지 않아서 시드는 start command에서 돌린다.

## 1. Render 계정과 Blueprint

1. https://dashboard.render.com 에서 GitHub로 가입하고 이 저장소 접근 권한을 준다.
2. **New → Blueprint** → 저장소 선택 → 브랜치 `main`. Render가 `render.yaml`을 읽어서 서비스 4개와 디스크를 보여준다.
3. `sync: false`인 변수들의 값을 묻는 화면이 나온다. 아래 표대로 넣는다. 지금 모르는 값(`PAYPAL_WEBHOOK_ID`, `REINS_API_KEY`)은 비워 두고 배포 뒤에 채운다. 이 화면은 처음 만들 때 한 번만 나온다. 나중에 바꿀 때는 각 서비스의 **Environment** 탭을 쓴다.
4. **Apply**를 누른다. 디스크와 상시 실행 때문에 웹 서비스 2개는 유료 인스턴스(`0.5c-512mb`)다. 크론은 실행한 시간만큼 과금된다. 요금은 Render 가격표에서 확인한다.
5. 첫 배포가 끝나면 `reins-web`이 빈 DB에 데모 데이터를 한 번 넣는다(에이전트 3개, "This month $117.97 of $410.00"). 재시작하거나 재배포해도 에이전트가 하나라도 있으면 다시 넣지 않는다(`seed.ts --if-empty`, `--force`는 절대 쓰지 않음).

서비스 주소는 보통 `https://reins-web.onrender.com`, `https://reins-mcp.onrender.com`이다. 이름이 이미 쓰이고 있으면 Render가 `reins-web-xxxx`처럼 접미사를 붙이므로 대시보드에 나온 실제 주소를 쓴다. 앱은 `PUBLIC_BASE_URL`이 없으면 Render가 넣어 주는 `RENDER_EXTERNAL_URL`을 쓰기 때문에 주소를 직접 적을 필요는 없다.

## 2. 붙여넣을 환경변수 (값은 절대 저장소에 쓰지 않는다)

### reins-web

| 변수 | 필수 | 어디서 가져오나 |
|---|---|---|
| `PAYPAL_CLIENT_ID` | 권장 | developer.paypal.com → Apps & Credentials → **Sandbox** 앱 → Client ID. 비우면 가짜 PayPal(fake)로 돈다 |
| `PAYPAL_CLIENT_SECRET` | 권장 | 같은 화면의 Secret |
| `PAYPAL_WEBHOOK_ID` | 배포 뒤 | 3단계에서 웹훅을 등록하면 나오는 Webhook ID. 없으면 웹훅 서명 검증이 실패한다 |
| `PAYPAL_SANDBOX_MERCHANT_EMAIL` | 선택 | 샌드박스 비즈니스 계정 이메일(developer.paypal.com → Testing Tools → Sandbox Accounts). Setup의 "Use demo merchant"에 표시된다 |
| `TREASURY_PAYEE_EMAIL` | 선택 | Treasury 모드를 쓸 때 받는 쪽 샌드박스 계정 이메일 |
| `ANTHROPIC_API_KEY` | 권장 | console.anthropic.com → API Keys. 비우면 결정적 mock 심사기 |
| `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` | 선택 | AG Grid Enterprise 키(체험판 키는 ag-grid.com 무료 신청). 비우면 공개 URL의 원장에 체험판 워터마크가 보인다. 빌드 때 읽으므로 넣은 뒤 재배포 |
| `TELEGRAM_BOT_TOKEN` | 선택 | BotFather에서 받은 토큰. 비우면 텔레그램 없이 웹 승인함만 쓴다 |
| `TELEGRAM_WEBHOOK_SECRET` | 텔레그램 쓸 때 | 직접 만든다: `openssl rand -hex 32`. 영문·숫자·`_`·`-`만 된다. 4단계 setWebhook에 같은 값을 넣는다 |

`render.yaml`에 이미 들어 있어서 넣을 필요 없는 값: `DATABASE_URL=file:/var/data/reins.db`, `PAYPAL_ENV=sandbox`, `PAYPAL_PAYMENT_MODE=supervised`, `REINS_TIMEZONE=Asia/Seoul`, `REINS_QUIET_HOURS=off`(심사위원 시간대 때문에 공개 데모에서는 끔), `REINS_PUBLIC_DEMO=1`(방문자 PayPal 키 입력 차단, 데모 판매자만 연결), `REINS_APPROVAL_TTL_MINUTES=30`, `TELEGRAM_BOT_USERNAME=ReinsApproveBot`(봇 이름이 다르면 Environment 탭에서 고친다), `NODE_VERSION=22`, `REINS_CRON_SECRET`(Render가 자동 생성해서 reconcile 크론과 공유).

`NODE_ENV`는 일부러 넣지 않았다. Render가 실행할 때만 `production`으로 설정한다. 빌드 때도 `production`이면 pnpm이 devDependencies(typescript, tsx)를 건너뛰어서 빌드와 시드가 깨진다.

`REINS_ADMIN_TOKEN`도 넣지 않는다. 넣으면 대시보드 API가 토큰을 요구해서 심사위원이 데모를 볼 수 없다. 공개 데모는 누구나 승인·거절할 수 있는 열린 모드다.

### reins-devops-cron

| 변수 | 어디서 가져오나 |
|---|---|
| `REINS_API_KEY` | 배포 뒤 `https://<web>/agents`에서 에이전트 "Claude Code - DevOps"를 만들고(카테고리 hosting, api-credits / 허용 render.com, vercel.com, anthropic.com, namecheap.com / 자동 승인 $30) 한 번만 보이는 `rk_live_...` 키를 복사한다. 시드 에이전트 키는 버려지기 때문에 쓸 수 없다. 이 값이 비어 있으면 크론이 "REINS_API_KEY is required"로 실패한다 |

`REINS_MCP_HOSTPORT`(→ `http://reins-mcp:10000/mcp`), `reins-mcp`의 `REINS_API_HOSTPORT`, reconcile 크론의 `REINS_WEB_HOSTPORT`와 `REINS_CRON_SECRET`은 Blueprint의 `fromService`가 채운다.

## 3. PayPal 웹훅 등록

1. developer.paypal.com → Apps & Credentials → Sandbox → Reins 앱 → **Webhooks → Add Webhook**.
2. Webhook URL: `https://<web>.onrender.com/api/webhooks/paypal` (예: `https://reins-web.onrender.com/api/webhooks/paypal`)
3. 이벤트 10개를 체크한다(`packages/core/src/webhooks.ts`의 `SUBSCRIBED_EVENTS`와 같다):
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.DECLINED`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.BLOCKED`, `PAYMENT.PAYOUTS-ITEM.RETURNED`, `PAYMENT.PAYOUTS-ITEM.DENIED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`
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

curl -sS $WEB/api/health                 # {"ok":true}  (DB 열기와 마이그레이션까지 확인됨)
curl -sS $WEB/api/overview | head -c 300 # "totals":{"spent_cents":11797,"limit_cents":41000,"agents":3,...}
curl -sS $MCP/health                     # ok

# MCP tools/list: 2단계에서 만든 에이전트 키 (rk_live_...)
 curl -sS -X POST $MCP/mcp \
  -H "Authorization: Bearer rk_live_..." \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# -> get_mandate, request_purchase, get_request_status, list_transactions

curl -sS -o /dev/null -w "%{http_code}\n" -X POST $WEB/api/cron/reconcile   # 401 (크론 비밀값 없이는 막힘)
```

그 밖에:

- 브라우저로 `$WEB/overview`, `$WEB/setup`을 연다. Setup 1단계 **Use demo merchant (sandbox)** 를 누르면 서버의 샌드박스 자격증명으로 연결된다. 심사위원은 자기 PayPal 키 없이 전체 흐름을 볼 수 있다.
- Render 대시보드 → `reins-devops-cron`, `reins-reconcile-cron` → **Trigger Run**으로 한 번씩 돌려 로그를 본다. devops는 "Infra cost check: ..."를, reconcile은 `{"window":...,"checked":...}`(건수만)를 찍는다.
- Claude Code에서 HTTP MCP로 붙이기: `claude mcp add --transport http reins $MCP/mcp --header "Authorization: Bearer rk_live_..."`.

## 운영 메모

- **데모 데이터 다시 넣기**: 시드는 실행한 달 기준으로 "이번 달" 숫자를 만든다. 달이 바뀌거나 대기 승인 항목이 만료되면(30분) 데모 녹화 직전에 다시 넣는다. `reins-web` → **Shell**에서 실행: `cd apps/web && node --import tsx ../../scripts/seed.ts --db "$DATABASE_URL"`. 직접 만든 에이전트 같은 다른 데이터가 있으면 거부하는데, 그때는 끝에 `--force`를 붙인다(시드 행만 바뀐다).
- **처음부터 다시**: Shell에서 `rm /var/data/reins.db` 후 Manual Deploy → 빈 DB에 다시 시드된다.
- **로그**: 비밀값·이메일은 찍지 않는다. reconcile은 건수만, Telegram 로그는 `REINS_TELEGRAM_LOG=1`일 때 카드 첫 줄만 남긴다.
- 서비스 4개는 사설망을 쓰기 때문에 같은 region(`oregon`)에 있어야 한다. region을 바꾸려면 4개 모두 바꾼다.
