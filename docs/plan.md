**1** 추천 1순위 · PayPal AI Hackathon

## Reins — AI 에이전트마다 한도·규칙·원탭 승인이 붙은 PayPal 지갑

"Hold the reins on AI spending." 에이전트가 MCP로 구매를 요청하면 하드 룰 → Claude 심사 → 텔레그램 원탭 승인 → PayPal 결제 → 감사 원장까지 한 번에 처리한다.

- **마감(KST)**: 11/13(금) 05:00 D-19 · PST 11/12 12:00

- **상금 총액**: $67,500 1st $12K · 2nd $8K · 3rd $5K

- **타겟 상**: Agentic Commerce + AG Grid 1st

- **등록자**: 20,107명 경쟁 치열

- **필수 요건**: PayPal 샌드박스 + AI "의미 있게" 통합

- **제출물**: 동작 데모 · OSS 저장소 영상 <3분 · 영어

- **심사 · 발표**: 12/1–15 발표 ~12/21

심사 5기준 동일 가중(Technological Implementation / Design / Potential Impact / Innovation / Presentation), AI 자동 분석 병용 가능. 심사위원 13명 중 PayPal 6명(DevRel 3, 엔지니어 2, PM 1), 나머지는 스폰서(AG Grid, APIMatic, Bryntum, Channel3, Elastic, Postman, Render). Grand/Honorable 1개 + 스폰서상 1개 중복 수상 가능. 1인 개발, 가용 18일(10/26–11/12, 하루 3~5시간).

출처: [공식 규정(Devpost)](https://paypalaihackathon.devpost.com/) [Agent Toolkit 퀵스타트](https://developer.paypal.com/community/blog/quickstart-guide-agent-toolkit/) [2025 Dev Days 수상작](https://developer.paypal.com/community/blog/winners-dev-days-hackathon) [Agentic Commerce 개요](https://developer.paypal.com/docsai/growth/agentic-commerce/overview) [Skyfire(TechCrunch)](https://techcrunch.com/2024/08/21/skyfire-lets-ai-agents-spend-your-money)

02

### 선정안

Selected

Reins 레인즈

Reins gives every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval, and a full audit trail — exposed as an MCP server any agent can call.

**해결 문제.** 오늘 에이전트에게 결제를 맡기는 방법은 "전부 주거나(카드/계정 공유) 아예 안 주거나" 둘뿐이다. 중간이 없으니 사람이 매번 끼어들고 자동화의 가치가 사라진다. 에이전트는 환각·프롬프트 주입으로 의도하지 않은 구매를 할 수 있고, 사고 후 "왜 샀는지" 추적도 안 된다. PayPal도 Agent Ready에서 supervised/automatic 두 모드를 전제하지만, 구매자 쪽에서 그 모드를 에이전트별·금액별·목적별로 정하는 도구는 없다. Reins가 그 빈칸이다.

**작동 원리(30초).**

1. 사용자가 PayPal(샌드박스)을 연결하고 에이전트마다 **위임장(Mandate)**을 쓴다: 월 한도, 건당 자동승인 한도, 허용 카테고리/판매자, 목적 문장.
1. 에이전트가 Reins MCP의 `request_purchase`(판매자, 금액, 품목, 이유)를 호출한다.
1. 정책 엔진이 **하드 룰**(한도·허용목록·속도)을 먼저 적용하고, 통과분은 **Claude가 위임장 대비 목적 일치도·위험도를 심사**해 `AUTO_APPROVE / ASK_HUMAN / DENY`와 한 문장 설명을 낸다.
1. `ASK_HUMAN`이면 텔레그램과 웹 승인함에 카드가 뜨고 탭 한 번으로 결정한다.
1. 승인되면 Orders v2로 결제(자동 모드: vault_id, 감독 모드: 승인 링크)하고 영수증을 에이전트에게 돌려주며 원장에 기록한다.

- **타겟 유저**: **1차** 에이전트를 돌리는 개인 개발자·1인 창업자(도메인 갱신·API 크레딧·부품 주문을 맡기고 싶지만 카드 번호를 주기 싫음)
**2차** 소규모 팀 운영 담당자(여러 에이전트 지출을 한 화면에서, $X 이상은 폰에서 승인)
**3차(스토리상)** 에이전트 플랫폼 개발자
- **핵심 가치**: "전부 아니면 전무"를 에이전트별·금액별·목적별 규칙으로 대체. 사람은 예외만 처리.
- **노리는 상**: Best Use of Agentic Commerce $5,000 AG Grid 1st $5,000 Most Creative Best Use of PayPal + AI Grand 3위권 APIMatic $1,000 Render 크레딧
- **포기**: Bryntum(일정 컴포넌트 부자연스러움), Channel3 단독상(데모 에이전트 상품 검색에만 사용)
- **PayPal API**: Orders v2(create/capture), Vault(Orders v2 store_in_vault → vault_id), Payouts v1(Treasury 대체 경로), Webhooks(verify-signature), Transaction Search(원장 대사)
- **AI**: Claude API: 구매 심사(JSON 구조화 출력), 위임장 카테고리 제안, 주간 요약, 거절 사유 EN/KO

03

### 승리 근거 · 심사 기준 대응
5기준 동일 가중

Technological Implementation20%

PayPal 4개 API 실사용(Orders v2 create/capture, Vault via Orders v2 store_in_vault, Payouts, Webhooks verify-signature) + Transaction Search로 원장 대사. 자체 MCP 서버(Streamable HTTP + stdio, 에이전트별 API 키). Claude를 "정책 심사관"으로 쓰되 **하드 룰이 선행하는 2단 구조**(LLM 단독 판단 금지)를 코드로 보여준다. 데모 에이전트는 Claude Desktop에 Reins MCP + Channel3 MCP를 함께 붙여 실제 상품 검색→구매까지.

Design20%

온보딩→위임장 작성→승인→원장까지 완결된 제품. 텔레그램 승인 카드와 웹 승인함이 동일 상태를 공유해 심사위원은 웹만으로 전 과정 체험 가능. 빈/로딩/오류/성공 상태를 모든 화면에 정의.

Potential Impact20%

PayPal 공식 문서의 supervised/automatic 구분, Skyfire·Payman 등 "에이전트 지갑" 스타트업의 존재가 문제의 실재성을 뒷받침. 대상이 "에이전트를 돌리는 모든 사람"이고 MCP 표준이라 즉시 적용 가능. 영상에서 프롬프트 주입으로 $450 결제 시도를 차단하는 장면으로 효과를 보여준다.

Innovation / Idea20%

경쟁작 대부분이 "에이전트가 PayPal로 결제한다"에 머무를 때, Reins는 "에이전트의 결제를 사람이 설계한 규칙과 AI 심사관이 통제한다"는 한 층 위의 문제를 푼다. "AI가 AI를 감사 + 사람은 예외만" 구도, AP2의 위임장(mandate) 언어를 제품화.

Presentation20%

3막 구조: 소액 자동 통과(10초) → 중간 금액 폰 알림·탭 승인·PayPal 캡처(40초) → 고액·목적 불일치 차단과 설명(20초). 화면 전환이 적고 숫자가 선명(한도 $60 중 $41 남음 등).

04

### 아이디어 회의 기록
20개 발산 → 3개 심층 → 1개 선정

"흔한 아이디어" 기준선: PayPal 블로그 예시(빵집 봇 쿠키 주문 → 인보이스 → 결제 링크 → 배송)와 2025 Dev Days 수상작(1위 CrawlerPal 에이전트 페이월, 2위 Shopware SDK v6 업그레이드, 3위 Rosen PYUSD 소셜 트레이딩). 인보이스 챗봇·대화형 쇼핑 봇·에이전트 페이월·기부/팁 봇은 이미 기본값이다. 프로젝트 갤러리·토론 게시판은 비로그인 403이라 경쟁작은 직접 확인하지 못했다.

#### ① Reins 28점 · 선정

AI 에이전트 지출 가드레일. MCP 서버 + 정책 엔진 + 텔레그램 + 대시보드.

**장점** PayPal 문서의 supervised/automatic 통제 계층을 제품화 → PayPal 심사위원 6명에게 "우리 로드맵 언어". 쇼핑 봇과 다른 메타 레이어. 영상이 자동으로 극적(통과/폰 알림/차단). 심사위원이 자기 Claude에 직접 붙여볼 수 있음. 원장이 AG Grid에 자연스럽고 APIMatic 기록 가능.

**단점** 개념이 추상적 → 첫 15초에 실제 상품·금액으로 못 박기. 구성요소 4개라 1인 18일에 빠듯.

**치명적 리스크** Vault(`vault_id`) 결제가 샌드박스에서 막힘 → Day 1~2 검증, 실패 시 선충전 지갑 + Payouts(Treasury) 모드. 업계 표준 방식이라 서사 손실 없음.

#### ② HaggleBots 25점

구매자·판매자 에이전트가 위임장 안에서 가격을 협상하고 합의 즉시 PayPal 결제.

**장점** 보는 재미 최대(가격 핑퐁). Agent Toolkit create_order/pay_order를 양쪽에 써서 PayPal + AI 어필. 구현 단순(결제 1종, UI 1화면).

**단점** "real problem for a real audience" 설득 어려움. 에이전트 협상은 반복된 소재라 Innovation 중간. Most Creative 하나만 겨냥.

**치명적 리스크** "장난감"으로 분류, Grand 가능성 낮음.

#### ③ Merge & Pay 23점

GitHub 이슈 현상금을 PR 머지 시 AI가 요건 검증 후 기여자에게 자동 지급.

**장점** DevRel/OSS 심사위원 공감(Eddie Jaoude). Orders+Payouts+Webhooks 조합 명확, AI 역할(PR 요건 판정)이 실질적.

**단점** Algora·Gitcoin·Polar 선행 제품. 3분 안에 GitHub 흐름 설명 부담. 특별상 매핑 약함.

**치명적 리스크** "PayPal은 에스크로가 아니다" — 후원금 보관 구조에서 규제·신뢰 문제 연상.

결론: Reins 확정. HaggleBots의 "판매자 에이전트" 요소는 Stretch X1(에이전트 간 결제 데모)로 흡수.

전체 발산 목록과 평가 매트릭스 (20개)

기준(각 1~5): a 필수 요건 충족 · b 심사 5기준 적합도 · c 1인·18일 구현 현실성 · d 차별화 · e 3분 영상 임팩트 · f 노릴 수 있는 특별상/스폰서상

   

| # | 아이디어 | 한 줄 설명 | 도메인 / 형태 | PayPal API | a | b | c | d | e | f | 합계 | 비고 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Reins | 에이전트에게 한도·규칙·사람 승인이 붙은 PayPal 지갑을 MCP로 제공 | 에이전트 결제·핀테크 / MCP+웹+텔레그램 | Orders v2, PMT v3, Payouts, Webhooks, Transaction Search | 5 | 5 | 3 | 5 | 5 | 5 | 28 | Agentic Commerce + AG Grid + APIMatic 동시 후보. Vault 샌드박스 확인 필요 |
| 4 | HaggleBots | 구매자·판매자 에이전트가 위임장 안에서 협상 후 결제하는 A2A 마켓 | 에이전트 간 결제 / 웹앱 | Orders v2, Agent Toolkit, Invoicing | 5 | 3 | 4 | 4 | 5 | 4 | 25 | 영상은 재밌지만 실제 문제 설득 약함 |
| 2 | Merge & Pay | GitHub 이슈 현상금을 AI가 PR 검증 후 자동 지급 | 개발자 도구 / GitHub 앱 | Orders v2, Payouts, Webhooks | 5 | 4 | 3 | 4 | 4 | 3 | 23 | DevRel 공감 높음. Algora 등 선행 |
| 10 | Procurement Desk | 팀 구매 요청 → Channel3 견적 비교 → 예산 승인 → 결제 → AG Grid 장부 | B2B 운영 / 봇+대시보드 | Orders v2, Channel3, Transaction Search | 5 | 4 | 3 | 3 | 4 | 4 | 23 | "업무용 쇼핑 봇"으로 묻힐 위험 |
| 9 | Shop by Voice | 시각장애 사용자용 음성 전용 쇼핑 에이전트 | 접근성 / 모바일 웹 | Orders v2 + Channel3 | 5 | 4 | 3 | 3 | 4 | 3 | 22 | Most Impactful 후보. 음성 UX 완성도 관건 |
| 12 | ChoreCoin | 집안일 인증 사진을 AI가 검증하고 용돈 지급 | 가정·교육 / 모바일 웹 | Payouts, Transaction Search | 5 | 3 | 4 | 3 | 4 | 3 | 22 | Most Creative 후보. 미성년 계정 이슈 |
| 3 | Trip Treasurer | 단톡방 영수증 사진 → AI 분담 계산 → 인보이스/정산 | 여행·소셜 / 텔레그램 봇 | Invoicing v2, Payouts, Webhooks | 5 | 3 | 5 | 2 | 3 | 2 | 20 | Splitwise 류 다수. 텔레그램 강점과는 최적 |
| 7 | Contract→Invoice | 계약서 PDF → 마일스톤 인보이스·반복 시리즈·독촉 | 프리랜서 / 웹앱 | Invoicing v2 | 5 | 3 | 5 | 2 | 3 | 2 | 20 | 인보이스 챗봇 계열 = 가장 흔함 |
| 11 | Studio Booker | 예약을 Bryntum 캘린더에 배치, 예약금 사전승인·노쇼 부분 청구 | 소상공인 / 웹앱 | Orders v2 authorize/capture, Bryntum | 5 | 3 | 3 | 2 | 3 | 4 | 20 | Bryntum 상 확률 높지만 $1,000 |
| 13 | Relief Cash | 재난 구호 신청 AI 1차 심사·중복 탐지 → 일괄 지급 | 비영리 / 웹앱 | Payouts batch, Webhooks | 5 | 3 | 3 | 3 | 3 | 3 | 20 | 민감 도메인, 신뢰 입증 어려움 |
| 14 | Sandbox Seeder | 자연어로 샌드박스 테스트 데이터 생성 CLI | 개발자 도구 / CLI | Orders, Subscriptions, Invoicing, Catalog | 4 | 3 | 4 | 4 | 2 | 3 | 20 | 개발자만 이해. Design 낮음 |
| 15 | Payout Reconciler | 벤더 정산을 주문과 대조, AI가 이상치 설명 후 승인분만 지급 | B2B 정산 / AG Grid | Transaction Search, Payouts | 5 | 3 | 3 | 3 | 2 | 4 | 20 | AG Grid 최적이나 영상 지루 |
| 18 | Agent Paywall | 에이전트 API·콘텐츠 호출당 결제(x402식) | 에이전트 결제 / API | Orders v2 | 5 | 3 | 4 | 2 | 3 | 3 | 20 | 2025 Dev Days 1위작과 동일 컨셉 |
| 6 | ChurnShield | 해지 의도 감지 → 일시정지·다운그레이드·할인 제안 즉시 적용 | 크리에이터·SaaS / 위젯 | Subscriptions v1, Transaction Search | 5 | 3 | 4 | 3 | 2 | 2 | 19 | 데모에 해지 상황 연출 필요 |
| 8 | Voice Invoice | 말로 작업 내용 → 인보이스+QR 즉석 발행 | 소상공인 / 모바일 웹 | Invoicing v2 QR | 5 | 3 | 4 | 2 | 3 | 2 | 19 |  |
| 16 | Tutor Escrow | 수업 전 사전승인, AI 출석 확인 시 캡처 | 교육 / 웹앱 | Orders v2 authorize/capture/void | 5 | 3 | 3 | 2 | 3 | 2 | 18 |  |
| 5 | Dispute Defender | 분쟁 시 AI가 증거 패키지 작성·제출 | B2B 셀러 / 웹앱 | Disputes v1, Orders tracking | 3 | 3 | 2 | 4 | 3 | 2 | 17 | 샌드박스 분쟁 생성에 계정 매니저 승인 필요 → 탈락 |
| 17 | Creator Tip Agent | 라이브 채팅 후원 의도 감지 → 결제 링크 | 크리에이터 / 봇 | Invoicing v2 | 5 | 2 | 4 | 1 | 3 | 1 | 16 |  |
| 19 | 동네식당 선주문 봇 | 텔레그램 자연어 주문 → 주문서 → QR 결제 | 소상공인 / 봇 | Orders v2, Invoicing QR | 5 | 2 | 5 | 1 | 2 | 1 | 16 |  |
| 20 | Round-up Giving | 결제 잔돈을 AI가 고른 단체에 자동 기부 | 비영리 / 웹앱 | Subscriptions, Payouts | 5 | 2 | 4 | 1 | 2 | 2 | 16 |  |

사전 조사: PayPal 개발자 기능 가용성 · 스폰서 도구 · 시장 맥락

   ````[](https://developer.paypal.com/docs/api/orders/v2/) ``````````[](https://developer.paypal.com/docs/api/payment-tokens/v3/)[](https://developer.paypal.com/docs/checkout/save-payment-methods/)[](https://developer.paypal.com/checkout/save-customer-info.md) ``[](https://developer.paypal.com/docs/api/payments.payouts-batch/v1/)[](https://developer.paypal.com/payouts/use-payouts/set-up) ````[](https://developer.paypal.com/docs/api/subscriptions/v1/) [](https://developer.paypal.com/docs/api/invoicing/v2/) ``[](https://developer.paypal.com/docs/api/customer-disputes/v1/)[](https://developer.paypal.com/disputes/test-go-live) ``[](https://developer.paypal.com/docs/api/transaction-search/v1/) ``[](https://developer.paypal.com/api/rest/webhooks/) ````[](https://github.com/paypal/agent-toolkit)[](https://github.com/paypal/agent-toolkit/tree/main/python) ``````[](https://developer.paypal.com/ai-tools/mcp-server)[](https://developer.paypal.com/ai-tools/agent-tools/) ``[](https://developer.paypal.com/ai-tools/build-with-llm) [](https://developer.paypal.com/docsai/growth/agentic-commerce/overview) ``[](https://developer.paypal.com/agent-ready/agentic-commerce-protocol) [](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/)

| 기능 | 핵심 엔드포인트 / 패키지 | 샌드박스 | 출처 |
|---|---|---|---|
| Orders v2 | POST /v2/checkout/orders, GET /{id}, PATCH, confirm-payment-source, authorize, capture, track | O | docs |
| Vault (Orders v2 store_in_vault) | /v3/vault/setup-tokens, /payment-tokens; 첫 주문 store_in_vault: ON_SUCCESS, usage_type: MERCHANT → 이후 payment_source.paypal.vault_id. payer 부재 청구 가능 | 샌드박스 확인: 별도 /v3/vault 호출 없이 Orders v2만으로 저장·재결제(10/28 스파이크) | API · 가이드 · md |
| Payouts v1 | POST /v1/payments/payouts, 배치/아이템 조회, cancel | O 비즈니스→개인 테스트 가능, Live는 별도 승인 | API · setup |
| Subscriptions v1 | /v1/billing/plans, /v1/billing/subscriptions(revise/suspend/cancel/capture) | O | docs |
| Invoicing v2 | invoices, send, remind, payments, generate-qr-code, search-invoices, templates | O | docs |
| Disputes v1 | disputes, accept-claim, provide-evidence, make-offer, escalate; 샌드박스 adjudicate | △ 테스트 분쟁 생성에 DISPUTE_CREATE 스코프 → 계정 매니저 요청 필요 | API · test |
| Transaction Search v1 | GET /v1/reporting/transactions, balances, daily-summary | O | docs |
| Webhooks | 앱당 URL 10개, 이벤트 *, 미응답 시 3일 25회 재시도, verify-signature | O | docs |
| Agent Toolkit (TS / Python) | @paypal/agent-toolkit 43 tools(Node 18+) / paypal-agent-toolkit 40 tools(Py 3.11+). OpenAI Agents, LangChain, Vercel AI SDK, MCP, CrewAI, Bedrock | O | GitHub · python |
| PayPal MCP 서버 | 로컬 npx -y @paypal/mcp --tools=all, 원격 mcp.sandbox.paypal.com/sse·/http. 원격 전용 search_product/create_cart/checkout_cart(현재 기프트카드만) | O | MCP · agent tools |
| LLM용 문서 | llms.txt, Anthropic MCP connector 예제 | - | docs |
| Agentic Commerce Services | Agent Ready / Store Sync, supervised·automatic 쇼핑 | X 폼 제출 후 온보딩 게이트 → 의존 불가 | overview |
| ACP (ChatGPT Instant Checkout) | Braintree + complete_checkout MCP 도구 | △ Braintree 샌드박스 별도 | guide |
| AP2 | 결제 위임장(mandate) 개념, PayPal 협력(2025-09) | 통합 가이드 없음 | blog |

- **Channel3**: AI 쇼핑 에이전트용 상품 검색 API(`api.trychannel3.com/v1/search`, 텍스트/이미지/URL, 무료 개발자 계정, MCP). [docs](https://docs.trychannel3.com/)
- **AG Grid**: 그리드 + AG Charts + AG Studio. 10/12 웨비나 "Build a payments dashboard without building a dashboard". 상금 5개(총 $10,000)로 스폰서상 중 최다.
- **APIMatic Context Plugin**: `npx context-plugins install paypal` — Claude Code/Cursor에 PayPal Server SDK 컨텍스트(베타). [blog](https://developer.paypal.com/community/blog/A%20New%20Context%20Plugin%20for%20AI-Assisted%20Coding%20with%20PayPal%20SDKs)
- **Bryntum**: Gantt/Scheduler/Calendar — 일정형 제품에만 자연스러움. **Render**: 웹 서비스·크론·Postgres, 배포처로 쓰면 자동 후보.
- **시장 맥락**: PayPal이 Agent Ready를 supervised/automatic으로 정의 → "에이전트 지출을 누가 어떤 규칙으로 통제하나"가 공식 관심사. Skyfire(에이전트별 지갑·한도·AgentID), Payman(에이전트→사람 지급)이 per-agent 한도·감사 로그·즉시 폐기를 핵심으로 내세움. PayPal 네이티브 + 오픈소스 MCP + 사람 승인 UX 조합은 검색 범위 내 없음.

05

### 기능 리스트
MVP Day 10 · Should Day 11–14 · Stretch Day 15–16

#### MVP 필수 · 14개

- **M1 PayPal 샌드박스 연결 온보딩**클라이언트 ID/시크릿 또는 데모 계정 버튼, OAuth 토큰 캐시
POST /v1/oauth2/tokenAI -난도 하

- **M2 에이전트 등록 + API 키**`rk_live_…` 형식, 해시 저장
AI -난도 하

- **M3 위임장 편집기**월 한도, 건당 자동승인, 허용/차단 도메인, 카테고리, 목적 문장, 유효기간
AI 카테고리 자동 제안난도 중

- **M4 Reins MCP 서버**TS `@modelcontextprotocol/sdk`, get_mandate / request_purchase / get_request_status / list_transactions, stdio + Streamable HTTP, Bearer 키
AI -난도 중

- **M5 정책 엔진 1단 (하드 룰)**한도·허용목록·만료·속도(10분 내 3건) → DENY/계속
AI -난도 중

- **M6 정책 엔진 2단 (LLM 심사)**위임장+요청+최근 10건 → `{decision, risk 0-10, reason_en, reason_ko}`. risk ≤3 & 금액 ≤ 자동한도 → AUTO, 그 외 ASK, 명백한 불일치·risk ≥8 → DENY
AI 핵심난도 중

- **M7 감독 모드 결제**주문 생성(intent CAPTURE, 승인 링크) → 웹훅 CHECKOUT.ORDER.APPROVED → capture
Orders v2Webhooks난도 중

- **M8 자동 모드 결제**온보딩 시 `store_in_vault: ON_SUCCESS` → 이후 `vault_id`로 주문·캡처. Day 2 검증 실패 시 M8' Treasury: 선충전 체크아웃 + Payouts
Orders v2PMT v3Payouts난도 상

- **M9 텔레그램 승인 봇**grammY, Approve/Deny 인라인 버튼, 결과 편집 메시지
AI 심사 사유 1줄난도 중

- **M10 웹 승인함**텔레그램과 동일 상태, 승인/거절/에이전트에게 질문
AI -난도 하

- **M11 원장 AG Grid**필터·정렬·에이전트별 그룹, 행 확장에 심사 사유·capture ID
Transaction Search난도 중

- **M12 웹훅 서명 검증·멱등**`/v1/notifications/verify-webhook-signature`
Webhooks난도 중

- **M13 데모 시드**에이전트 3 · 거래 24 · 위임장 3 한 번에 생성
AI -난도 하

- **M14 데모 에이전트 A**Claude Desktop/Code에 Reins MCP + Channel3 MCP 설정 파일
AI 에이전트 자체난도 하

#### Should Day 11–14 · 7개

- **S1 개요 대시보드**총지출, 에이전트별 한도 막대, 카테고리 도넛(AG Charts), 최근 결정 피드
Transaction SearchAI 주간 요약난도 중

- **S2 에이전트에게 질문**MCP get_request_status에 needs_clarification + 질문 전달 → 답하면 카드 갱신
AI 답변 요약난도 중

- **S3 이상 패턴 감지**동일 판매자 반복, 심야 요청, 위임장 밖 카테고리 → 위험도 가중 + 경고
AI 패턴 설명난도 중

- **S4 영수증 반환**`{capture_id, amount, merchant, receipt_url}` + 영수증 페이지
Orders v2난도 하

- **S5 한도 즉시 조정**"승인 + 이 판매자 자동허용" 원탭
AI 규칙 문장 생성난도 하

- **S6 데모 에이전트 B**Render Cron DevOps 에이전트, 매일 인프라 비용 점검 후 소액 자동결제
Orders v2난도 하

- **S7 APIMatic 개발 기록**Context Plugin 사용 과정 README 섹션 + 커밋 로그
AI -난도 하

#### Stretch Day 15–16 · 5개

- **X1 에이전트 간 결제**판매자 에이전트(Agent Toolkit create_invoice/create_order)가 청구 → 구매자 에이전트가 Reins로 결제
Agent ToolkitInvoicing v2난도 상

- **X2 구독형 지출 통제**에이전트 구독을 월 한도에 합산, 초과 예상 시 suspend 제안
Subscriptions v1AI 예측 설명난도 상

- **X3 위임장 자연어 작성**"개발 인프라에 월 150불, 30불 넘으면 물어봐" → 구조화
AI 파싱난도 중

- **X4 정책 시뮬레이터**과거 24건에 새 위임장 적용 미리보기
AI 차이 설명난도 중

- **X5 Postman 컬렉션**Reins REST + MCP 호출 예제
AI -난도 하

06

### 유저 플로우

플로우 A · 온보딩과 첫 위임장 (Minji Park, 서울, 1인 개발자)

1. **reins.app 접속, "Connect PayPal Sandbox"**ID/시크릿 폼 또는 "Use demo merchant"→ S1
1. **자격증명 입력 → Verify**oauth2/token 성공 → "Connected: sb-merchant-47xk@…" 배지→ S1
1. **"Save a PayPal for automatic payments"**$0.01 검증 주문(store_in_vault) → 승인 창 → 캡처 → vault_id 저장→ S1 모달
1. **분기: Treasury 폴백**Vault 불가 시 "Prefund $200" 체크아웃→ S1 모달
1. **텔레그램 Link**t.me/ReinsApproveBot?start=lk_8f3a → "Linked to Minji's workspace"→ S1
1. **첫 에이전트 "Claude Code – DevOps"**월 $150 · 자동 $30 · namecheap/vercel/render/anthropic → 키 rk_sb_7Hq2… 1회 표시 + MCP 스니펫→ S2
1. **스니펫을 claude_desktop_config.json에**Claude Desktop에 reins 도구 4개 노출→ 외부

플로우 B · 에이전트 구매 요청 3가지 결말 (핵심 데모)

1. **"reins.dev 도메인 갱신해줘"**request_purchase(namecheap.com, $12.98, "Domain expires Nov 30")→ Claude Desktop
1. **AUTO 통과**하드 룰 통과 → LLM AUTO_APPROVE risk 1 → vault_id 주문·capture COMPLETED→ S4 초록 Paid
1. **에이전트에 영수증**{status:"paid", capture_id:"8XK21…"} → "갱신 완료, $12.98 결제됨"→ 외부
1. **Research Scout "시장 보고서 구해줘"**Channel3 검색 → statista.com $59.00 요청→ 외부
1. **ASK_HUMAN**$60 중 $41 남음, 자동한도 $25 초과 → risk 2 → 텔레그램 + 승인함, 에이전트에 pending_human R-0142→ S3 / S5
1. **폰에서 Approve 탭**"Paying…" → "Paid $59.00 · Capture 3GH…" 편집, 승인함 비워짐→ S3 → S4
1. **주입된 웹페이지 요약**숨은 지시 → fiverr.com $450 "Instructed by page"→ 외부
1. **DENY**하드 룰(건당 $100 초과·미허용) + LLM "likely prompt injection" → 경고 카드(Review만)→ S3 / S6

플로우 C · 사후 검토와 규칙 조정

1. **주말에 대시보드**"This month $117.97 of $410 across 3 agents", 경고 1건(R-0143)→ S7
1. **원장에서 Research Scout 그룹·행 확장**심사 사유, 위임장 스냅샷, capture ID, 대사 "matched"→ S4
1. **R-0143 "Tighten mandate"**제안 프리필: Block fiverr.com, Per-tx cap $60→ S6 → S2
1. **저장**v3 생성, 다음 get_mandate부터 적용→ S2

[07 화면 목업: 아티팩트 참조]

08

### 실행 계획

#### 아키텍처
 flowchart LR AG["Agent: Claude Desktop / Code + Channel3 MCP"] -->|"MCP request_purchase"| MCP["apps/mcp @reins/mcp stdio + HTTP"] MCP -->|"POST /api/requests Bearer key"| WEB["apps/web Next.js 15 API"] WEB --> HR{"Hard rules"} HR -->|"cap / allowlist fail"| DN["DENY"] HR -->|pass| LLM["LLM audit: Claude Messages API"] LLM -->|"risk le 3 and amt le auto"| PAY["core.pay.execute: Vaulted / Supervised / Treasury"] LLM -->|ASK| Q["Telegram bot grammY + Web queue SSE"] LLM -->|"risk ge 8"| DN Q -->|approve| PAY Q -->|reject| DN PAY -->|"Orders v2 / Payouts v1"| PP[("PayPal Sandbox")] PP -->|"Webhooks verify-signature"| WEB WEB --> DB[("Postgres Drizzle on Render")] DN --> DB DB --> UI["AG Grid Ledger + AG Charts"] CRON["Nightly cron"] -->|"Transaction Search"| PP CRON --> DB

**모노레포 `reins/` (전부 TypeScript)**: apps/web(Next.js 15 App Router, UI + /api/* + /api/webhooks/paypal) · apps/mcp(stdio 로컬 + Streamable HTTP Render, 내부적으로 web REST 호출) · apps/bot(grammY 웹훅, web과 합쳐도 됨) · packages/core(정책 엔진, fetch 기반 PayPal 클라이언트 `api-m.sandbox.paypal.com`, 결제 전략 3종) · packages/db(Drizzle + Postgres, 로컬 SQLite libsql) · agents/(claude_desktop_config.json, DevOps 크론, 판매자 에이전트).

1. 에이전트 → MCP `request_purchase` → `POST /api/requests`
1. `core.policy.hardRules()` 실패 시 즉시 DENY
1. `core.policy.llmAudit()` → Claude(도구 사용으로 JSON 강제, 모델 ID는 구현 시 최신값 고정)
1. AUTO → Vaulted: orders에 `payment_source.paypal.vault_id` + `stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT}`(필드 조합 Day 2 실측) / Supervised: return_url 승인 링크 → APPROVED 웹훅 → capture / Treasury: `POST /v1/payments/payouts` → PAYOUTS-ITEM.SUCCEEDED
1. ASK → pending_human → 텔레그램 inline keyboard + SSE → 콜백 → 4
1. 웹훅 → verify-signature → 멱등(event id) → 원장 → SSE
1. 야간 크론 Transaction Search로 custom_id/capture id 대사

**보안**: 에이전트 키 해시 저장, 멱등 키(agent_key + client_request_id), LLM 입력에 PayPal 자격증명·vault_id 미포함, 거절 사유에 원문 프롬프트 노출 금지, 비밀값은 Render 환경변수, 로그에 PII 없음.

**AI 사용 명세**: Claude API (1) 구매 심사 (2) 카테고리 제안 (3) 주간 요약 (4) 거절 사유 EN/KO. 개발: Claude Code + APIMatic PayPal Context Plugin.

#### 일정 (18일 · 하루 3~5시간)

D1 10/26 (일)**계정·스캐폴드**샌드박스 앱, 비즈니스/개인 계정, **Vault 토글 존재 확인**, 모노레포, Render, 봇 토큰, APIMatic 설치

D2 10/27**결제 스파이크**(a) 일반 주문→승인→캡처 (b) store_in_vault → vault_id 재주문 캡처. Vaulted/Treasury 확정

D3 10/28**Payouts·웹훅 스파이크**비즈니스→개인 송금, ngrok 웹훅 + verify-signature, 이벤트 목록 확정

D4 10/29**DB·REST**agents, mandates(versioned), requests, decisions, payments, webhook_events. CRUD·키 발급

D5 10/30**하드 룰**단위 테스트 12케이스

D6 10/31**LLM 심사**프롬프트·스키마·경계·실패 시 ASK_HUMAN 기본값, 골든 케이스 10개

D7 11/1**MCP 4도구**Claude Desktop에서 AUTO 경로 결제 성공

D8 11/2**텔레그램 봇**딥링크, 승인 카드, 콜백→결제→편집, 만료 타이머

D9 11/3**웹 셸 + S2 + S5**SSE, 디자인 토큰

D10 11/4**S4 원장 + S1 · 체크포인트**플로우 B 3결말 처음부터 끝까지 시연 가능

D11 11/5**Render 배포**web+mcp HTTP, Postgres, 웹훅 URL, 시드 M13, 데모 계정 버튼

D12 11/6**S6 드로어 + S7 개요**AG Charts, 주간 요약

D13 11/7**Should**Ask agent, 즉시 허용, 영수증, DevOps 크론

D14 11/8**기능 동결**빈/로딩/오류 점검, 360/720/1440, 키보드 접근

D15 11/9**README·LICENSE**5분 설치, 아키텍처, API 표, 선행 제품 비교, 보안 노트, MIT, Postman(선택), 대본 확정

D16 11/10**영상 촬영**1440p 녹화 + 갤럭시 실촬영 + 보이스오버, 1차 편집

D17 11/11**업로드·폼**YouTube 공개, Devpost 폼, 깨끗한 환경 재설치 테스트

D18 11/12 (목)**제출 KST 20:00 이전**마감까지 9시간 버퍼, 이후 수정 금지

여유 규칙: Day 2 결과가 나쁘면 Day 3에 Treasury 확정. Day 10 체크포인트 실패 시 S7·Ask agent·DevOps 에이전트 삭제.

#### 3분 영상 시나리오 (총 2:50)

0:00–0:12**훅.** "I let Claude renew my domains, buy datasets, restock my desk. Last week a web page told it to buy a $450 logo. Here's why nothing was charged." 검은 화면 텍스트 → 로고 1초

0:12–0:30**문제+제품.** "Agents can pay today — all or nothing. Reins gives each agent a PayPal wallet on a leash…" S2 에이전트 3개, 위임장 줌

0:30–0:50**1막 자동 승인.** "Renew reins.dev" → 도구 호출 → 3초 후 "Paid $12.98". Claude Desktop | 원장 분할, 샌드박스 거래 2초 컷

0:50–1:40**2막 사람 승인.** Channel3 검색 → $59 요청 → 폰 울림 → Approve → "Paid" → 승인함 비워짐 → 원장 갱신. "Everything over $25 asks me." 데스크톱 ↔ 갤럭시 실촬영 교차

1:40–2:10**3막 차단.** 주입 페이지 → $450 fiverr → Denied → 텔레그램 경고 → S6 FAIL 3개 + "looks like prompt injection". "Rules first, then an AI auditor explains." S6 확대

2:10–2:30**기술 15초.** Orders v2(+Vault 저장 결제) + Payouts + Webhooks + Transaction Search, 자체 MCP, Claude 심사, AG Grid, Render. 정적 아키텍처 그림

2:30–2:50**임팩트.** "PayPal's Agent Ready already distinguishes supervised from automatic shopping. Reins is where you decide which is which — per agent, per dollar. Open source, MIT, connect in 5 minutes." S7 → 엔드 카드(GitHub·데모 URL)

촬영 규칙: PayPal 로고 등 상표를 장식에 쓰지 않음(샌드박스 화면은 동작 증명용 최소 노출), 음악은 라이선스 프리 또는 무음, 자막 영어.

#### 리스크와 완화

**R1. Vault 자동결제가 샌드박스에서 불가/불안정**
완화: Day 1~2 실측. 실패 시 Treasury 모드(Orders v2로 $200 선충전 → Payouts로 판매자 이메일에 지급). 전략 패턴으로 3모드 준비, UI 문구만 변경. 감독 모드는 어느 경우든 동작.

**R2. "이미 있는 것 아니냐"(Skyfire, 카드사 에이전트 토큰)**
완화: README·영상에 선행 제품 명시 + 차이 3줄 — PayPal 네이티브(별도 지갑·크립토 불필요), 오픈소스 MCP(5분 연결), 사람 승인 UX·AI 심사 설명.

**R3. 1인 18일 범위 초과 / MCP↔Telegram↔PayPal 지연**
완화: MVP 경계 고정, Day 10 촬영 가능 체크포인트, Day 14 기능 동결. 로컬 stdio + 시드 데이터로 지연 최소화, 텔레그램은 실폰 촬영. 웹 승인함이 완전 대체재.

#### 미확인 항목 (Day 1~2에 닫기)

1. **샌드박스 vault 스파이크**: 샌드박스 앱 Features에 "Save payment methods" 토글 존재 여부와 PayPal 지갑 vault 저장 가능 여부([문서는 Live 기준](https://developer.paypal.com/docs/checkout/save-payment-methods/)).
1. `vault_id` + `stored_credential{payment_initiator:"MERCHANT"}`로 buyer 부재 캡처 성공 여부, 실패 코드 기록.
1. Orders v2 `purchase_units[].payee.email_address`로 다른 샌드박스 비즈니스 계정 직접 지급 가능 여부(X1용), 안 되면 Payouts.
1. AG Grid Enterprise(행 그룹·마스터 디테일) 사용 여부 — Community 기본, 트라이얼 워터마크가 영상에 안 보일 때만.
1. Channel3 무료 계정 발급과 MCP 설정 방법([docs](https://docs.trychannel3.com/)).

#### 제출 체크리스트

- Devpost 프로젝트 생성, 제목 "Reins — spending guardrails for AI agents on PayPal", 태그라인 1문장
- 텍스트 설명: 문제/해결/작동 원리/PayPal API 목록(엔드포인트명)/AI 사용 방식/선행 제품 대비 차이/한계와 다음 단계
- "Tools": Claude API(용도 4가지), Orders v2(Vault store_in_vault 포함)·Payouts v1·Webhooks·Transaction Search, Channel3, AG Grid·AG Charts, Render, APIMatic Context Plugin
- 공개 GitHub 저장소, 루트 LICENSE(MIT) + About 라이선스 표시, README 5분 설치·실행, .env.example, 시드 명령, MCP 스니펫, 데모 계정 안내
- Render 호스팅 데모 URL + "Use demo merchant"로 자격증명 없이 체험, 웹 승인함으로 텔레그램 없이 전 플로우
- YouTube 공개 영상 < 3:00, 갤럭시 실기기 텔레그램 장면, 상표·저작권 음악 없음
- 스폰서상 체크박스: Agentic Commerce, AG Grid, APIMatic, Render
- 영어 검수(설명·README·영상 자막)
- 제출 후 시크릿 모드에서 데모 URL·저장소·영상 3개 링크 재확인
- 마감 11/13 05:00 KST — 목표 제출 11/12 20:00 KST
