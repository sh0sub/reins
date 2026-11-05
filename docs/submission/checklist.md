# 제출 체크리스트 (Devpost, 마감 2026-11-13 05:00 KST, 목표 11-12 20:00 KST)

상태: 완료 / 남음-Claude / 남음-사용자 계정 필요. 사용자 계정이 필요한 일은 Render 가입+Blueprint 적용, YouTube 업로드, Devpost 폼 제출 세 가지뿐이다.

## Devpost 폼 필드

| 항목 | 상태 | 메모 |
|---|---|---|
| 프로젝트 이름 / 태그라인(200자 이하) | 완료 | `docs/submission/devpost.md` (164자) |
| Inspiration | 완료 | 선행 제품(Skyfire, 카드사 토큰) 차이 3줄 포함 |
| What it does | 완료 | |
| How we built it (PayPal 엔드포인트, MCP 4툴, Claude 심사+mock, AG Grid, Render) | 완료 | 엔드포인트는 코드로 확인 |
| Challenges / Accomplishments / What we learned / What's next | 완료 | |
| Built with 태그 | 완료 | |
| Try it out 링크: 저장소 | 완료 | https://github.com/sh0sub/reins |
| Try it out 링크: 라이브 URL | 남음-사용자 계정 필요 | Render 배포 뒤 실제 주소로 교체(`reins-web.onrender.com` 자리표시) |
| Try it out 링크: MCP 주소 | 남음-사용자 계정 필요 | 배포 뒤 확인(`reins-mcp.onrender.com/mcp`) |
| 영상 링크 | 남음-사용자 계정 필요 | YouTube 업로드 후 URL |
| Devpost 첫머리 3줄 피치, PayPal API 표(실제 샌드박스/가짜 구분), 단일 "Limits" 목록 | 완료 | R1 (devpost.md 상단) |
| For judges 2분 체험 블록 | 완료 | 웹 승인함(텔레그램 없이), MCP 설정 스니펫 포함 |
| 스폰서상 체크박스: Agentic Commerce, AG Grid, Render | 남음-사용자 계정 필요 | 폼에서 체크(문단은 devpost.md에 있음) |
| 스폰서상 체크박스: APIMatic | 남음-Claude | 저장소에 사용 증거 없음. 아래 "APIMatic" 참고(경고문은 `docs/submission/internal-notes.md`로 옮김, devpost.md에는 없음). 증거 없으면 체크하지 않는다 |
| Devpost 폼 제출 | 남음-사용자 계정 필요 | 제출 후 수정 금지 |

## 저장소

| 항목 | 상태 | 메모 |
|---|---|---|
| 공개 GitHub 저장소 + 루트 LICENSE(MIT) | 완료 | About 라이선스 표시는 GitHub 설정에서 확인 필요 |
| README(소개, 아키텍처, 빠른 시작, MCP 스니펫, 보안 노트, 선행 제품) | 완료 | |
| README: 영상·라이브 URL 자리 | 남음-사용자 계정 필요 | 업로드/배포 뒤 실제 링크로 교체 |
| README: API 표(이슈 #41) | 완료 | MCP 도구-REST 표와 영역별 엔드포인트 표 (MCP 연결 섹션 아래로 이동) |
| README 첫 화면 스크린샷·GIF | 완료 | `docs/img/` 개요·승인 카드·요청 드로어·원장 1440/390 PNG 8장 + $450 거절 GIF, README "See it" 섹션 |
| README: APIMatic 개발 기록 섹션(이슈 #21) | 남음-Claude | 실제 사용 후 작성 |
| `.env.example`, 시드 명령, MCP 스니펫 | 완료 | 오래된 디스크/크론 주석 정리함 |
| 테스트·린트 | 완료 | 246 tests / 37 files 통과, `pnpm typecheck`·`pnpm lint` 통과 (2026-11-04) |
| 영어 검수(README, 설명) | 남음-Claude | 최종 읽기 한 번 더 |
| 커밋·푸시 | 완료 | 2026-11-01 영상 스크립트·문서 갱신 커밋 |
| `@reins/mcp` npm 미발행 | 안내 완료 | README·devpost.md에 "짧은 `npx` 설정은 발행 전에는 동작하지 않음, 클론 stdio 또는 HTTP 사용" 명시. Agents 화면 스니펫도 클론 기반 stdio(`npx -y tsx <경로>/apps/mcp/src/stdio.ts`)로 변경 |
| 갤러리 스크린샷(`.local/screenshots`, 12장) | 완료 | 재생성: 개요, 승인함(Vercel 카드), 차단 드로어, 원장 행, 영수증, 에이전트, Cmd+K, 390px 원장. Devpost에 업로드는 사용자 몫 |

## 배포(Render)

| 항목 | 상태 | 메모 |
|---|---|---|
| `render.yaml`, `docs/deploy.md` | 완료 | 무료 플랜, 디스크·크론 없음 |
| Render 가입 + Blueprint 적용, 환경변수 입력 | 남음-사용자 계정 필요 | `docs/deploy.md` 1~2단계 |
| PayPal 웹훅 등록 + `PAYPAL_WEBHOOK_ID` 입력 | 남음-사용자 계정 필요 | deploy.md 3단계 |
| Telegram 웹훅 등록(쓸 때만) | 남음-사용자 계정 필요 | deploy.md 4단계 |
| smoke check 실행 | 남음-Claude | 배포 후 URL을 받으면 deploy.md 5단계를 대신 실행 |
| 제출 직전에 서비스 깨우기 | 남음-사용자 계정 필요 | 15분 무요청 시 잠들고 데모 상태 초기화 |

## 영상

| 항목 | 상태 | 메모 |
|---|---|---|
| 영상 대본·촬영 스크립트(`scripts/demo/video-shots.mjs`) | 완료 | 2026-11-01 재녹화: 사이드바 에이전트 목록, Cmd+K로 차단 요청 이동, 요청 드로어(하드 룰 표·위험도), 새 승인 카드(체크박스+Approve), 월 합계 $176.97 반영. 이전 영상은 `.local/video/reins-demo-prev.mp4` |
| 3분 미만, 상표·저작권 음악 없음 확인 | 완료 | 2:34(153.9초; 오프닝은 결제 완료+$450 거절 페이오프, 훅 3.4초, 엔드 카드 6초), macOS 음성 해설만, 음악 없음, 프레임 컨택트 시트로 깨진/멈춘 화면 없음 확인. 영상 파일은 커밋하지 않음(`.local/`) |
| 월 한도 문구 단위 통일 재녹화(C2 UI-1) | 남음 | 하드 룰 문구가 "Spent $9.00 + this $450.00 = $459.00 > $100.00 monthly cap"으로 바뀜. 영상의 R-0143 드로어 프레임이 옛 문구("$91.00 of $100.00 left")라 재녹화 필요 |
| 사이클 7: /try 놀이터·`pnpm judge`·Money protected 카드 (S1/S2) | 완료 | `/try`(프리셋 3개+자유 입력+"Simulate a fooled auditor"), `pnpm judge`(임시 DB, 가짜 PayPal, 3100 포트), 개요 "Money protected" 카드, /setup·/overview 서버 렌더. 영상에는 아직 없음: 카드와 /try는 재녹화 때 넣을지 결정 |
| 사이클 7: 영상 재녹화 필요 구간 (S3) | 남음-재녹화 | 개요 구간(새 Money protected 카드, 상태 칩 "is paused"), /setup 구간(제목이 단계에 맞게 바뀜), 원장 PayPal ID(`SIM-…`+simulated 칩), 영수증 구간. 녹화기는 이제 `next build`+`next start`(개발 오버레이 없음). 재녹화 때 길이 3:00 미만 유지 확인 |
| 사이클 7: Devpost TL;DR·README 정리 (S4) | 완료 | TL;DR 5줄, Limits 이동·축약, Agentic Commerce/AG Grid 블록, README 상단 Try it + 실제/모의 표 |
| 데스크톱 승인 바(C4 P1) | 완료 | 1440x900에서 Approve/Deny가 접힘 아래에 있던 문제 수정: 720px 이상에서도 상세 패널 하단에 sticky 바(A/D 힌트). `docs/img/approval-1440.png`·`ledger-1440.png` 재촬영(KPI 타일 보이게 맨 위). 영상의 승인 구간(1440)은 옛 레이아웃이라 재녹화 시 반영됨 |
| Devpost·README 비교 표(C2 DEV-1) | 완료 | Skyfire/카드 토큰/PayPal Agent Toolkit 표. C3 M4: "Compose: gate the Toolkit" 행 추가, 옵트인 어댑터(`packages/core/src/pay/toolkit.ts`). C4 K1: 실제 `@paypal/agent-toolkit` 1.11.0으로 샌드박스에서 `create_order` 승인 1건 성공·거절 1건 Toolkit 호출 0회 확인(`docs/spikes/d5-toolkit-gate.md`). 캡처(`pay_order`)는 구매자 승인 필요로 PayPal이 422 거절 — 미완료라고 명시. Devpost 표·README 갱신 |
| 영상 실제/모의 구분표(C5 M4) | 남음-최종 컷 후 | 최종 컷이 나오면 mm:ss 구간을 채울 것. 지금 확정된 구분: 모의(가짜 PayPal 클라이언트·오프라인 감사기) = 훅, 자동 결제, 한도 초과 승인, $450 거절, 원장, 엔드 카드 / 실제(PayPal 샌드박스 + 실제 Claude) = 'REAL RUN' 배지 구간 하나(약 10초, 별도 녹화) / Telegram 카드 = 실제 봇의 카드 텍스트를 패널로 표시. 실제 구간 mm:ss: __:__–__:__ |
| 영상 설명 정합(C3 M6) | 남음-재녹화 후 | Devpost "Limits"·README가 "본편은 가짜 PayPal 클라이언트, 'REAL RUN' 배지 구간(약 10초)만 실제 샌드박스"라고 적음. 재녹화 뒤 해당 구간의 정확한 초(mm:ss-mm:ss)를 여기와 Devpost Limits에 채울 것 |
| 영어 전용 화면(C3 M5) | 완료 | 승인·위험 카드·원장·드로어에서 한국어 reasonKo는 `<html lang="ko">` 또는 `?lang=ko`일 때만 표시(데이터는 유지). docs/img 4장 재촬영. 영상은 재녹화 필요 |
| 공유 링크 안전(C3 M5) | 완료 | `/approvals/R-0143`(이미 결정됨)은 "already decided (Blocked)"+결정 기록 링크, 없는 id는 "Request not found", 승인 바 숨김, 탭 제목 반영 |
| 선행 제품 차이 3줄 영상 반영(이슈 #44) | 완료 | 마지막 카드 해설에 반영 |
| 갤럭시 실기기 텔레그램 장면(계획서) | 남음-사용자 계정 필요 | 대본은 봇 카드 텍스트 패널 사용. 실기기 장면이 필요하면 직접 촬영 |
| YouTube 공개 업로드 | 남음-사용자 계정 필요 | 공개(Public) 설정 |

## APIMatic

저장소 검색 결과 APIMatic은 `docs/plan.md`와 이슈 #21·#41에만 계획으로 나온다. 코드, 커밋, README에 사용 기록이 없다. Reins는 PayPal을 REST로 직접 호출하고 PayPal Server SDK를 쓰지 않는다. 남은 일(Claude): `npx context-plugins install paypal` 설치, Claude Code로 실제 작업 1건 이상(예: Orders v2/Payouts 호출 점검), README "Built with APIMatic" 섹션과 커밋 기록, 그 뒤 devpost.md APIMatic 문단 확정. 설치에 APIMatic 계정이 필요하면 그 부분만 사용자 몫이다.

## 제출 직전·직후

| 항목 | 상태 | 메모 |
|---|---|---|
| 깨끗한 환경 재설치 테스트(D17) | 남음-Claude | 새 디렉터리 clone, 빠른 시작 그대로 실행 |
| 제출 후 시크릿 모드에서 라이브·저장소·영상 3개 링크 확인 | 남음-사용자 계정 필요 | 링크 열림 확인 |
| 제출 후 수정 금지(D18) | 남음-사용자 계정 필요 | |
