#!/usr/bin/env bash
# PayPal 샌드박스 자격 증명 등을 .env에 안전하게 저장한다. 입력값은 화면·히스토리·로그에 남지 않는다.
# 사용: bash scripts/setup-env.sh   (별도 터미널에서 실행)
# 나중에 다른 키를 추가할 때도 같은 스크립트를 다시 실행하면 된다(기존 값은 유지, 입력한 값만 갱신).
set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."

ENV_FILE=".env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# 키 이름, 설명, 비밀 여부(1이면 입력이 화면에 안 보임)
KEYS=(
  "PAYPAL_CLIENT_ID|PayPal 샌드박스 앱 Client ID|1"
  "PAYPAL_CLIENT_SECRET|PayPal 샌드박스 앱 Secret Key|1"
  "PAYPAL_SANDBOX_BUYER_EMAIL|샌드박스 Personal(구매자) 계정 이메일 (Testing Tools > Sandbox Accounts)|0"
  "PAYPAL_SANDBOX_PAYEE_EMAIL|두 번째 샌드박스 Business 계정 이메일 (없으면 Enter)|0"
  "ANTHROPIC_API_KEY|Claude API 키 (없으면 Enter)|1"
  "TELEGRAM_BOT_TOKEN|BotFather 토큰 (없으면 Enter)|1"
  "TELEGRAM_BOT_USERNAME|텔레그램 봇 username, @ 없이 (없으면 Enter)|0"
  "CHANNEL3_API_KEY|Channel3 API 키 (없으면 Enter)|1"
  "PAYPAL_PAYMENT_MODE|자동 결제 모드: vaulted | supervised | treasury (D2 스파이크 결과 vaulted 권장)|0"
  "PAYPAL_WEBHOOK_ID|PayPal 웹훅 ID (cat .local/webhook-id.txt 로 확인, 17자)|0"
  "PUBLIC_BASE_URL|공개 베이스 URL (터널 주소 https://xxx.trycloudflare.com, 로컬이면 Enter)|0"
)

set_kv() { # name value
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v -E "^${name}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

# 인자로 키 이름을 주면 그 키만 묻는다. 예: bash scripts/setup-env.sh TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME
ONLY=("$@")
wanted() { [ ${#ONLY[@]} -eq 0 ] && return 0; for k in "${ONLY[@]}"; do [ "$k" = "$1" ] && return 0; done; return 1; }

echo "값을 붙여넣고 Enter. 건너뛰려면 그냥 Enter (기존 값 유지)."
for row in "${KEYS[@]}"; do
  IFS='|' read -r name desc secret <<< "$row"
  wanted "$name" || continue
  printf '%s [%s]: ' "$desc" "$name"
  if [ "$secret" = "1" ]; then read -rs v; echo; else read -r v; fi
  # 붙여넣기 마커(ESC[200~ / ESC[201~)·제어문자·비ASCII 바이트 제거 (키 값은 ASCII)
  v="$(printf '%s' "$v" | LC_ALL=C tr -cd '\041-\176')"
  [ -z "$v" ] && continue
  set_kv "$name" "$v"
  echo "  저장 (${#v}자)"
done

# 기본값(없을 때만)
grep -q -E '^PAYPAL_ENV=' "$ENV_FILE" || printf 'PAYPAL_ENV=sandbox\n' >> "$ENV_FILE"
grep -q -E '^PAYPAL_PAYMENT_MODE=' "$ENV_FILE" || printf 'PAYPAL_PAYMENT_MODE=supervised\n' >> "$ENV_FILE"
grep -q -E '^DATABASE_URL=' "$ENV_FILE" || printf 'DATABASE_URL=file:./.local/reins.db\n' >> "$ENV_FILE"
grep -q -E '^PUBLIC_BASE_URL=' "$ENV_FILE" || printf 'PUBLIC_BASE_URL=http://localhost:3000\n' >> "$ENV_FILE"
mkdir -p .local

echo
echo "저장 완료: $ENV_FILE (권한 600). 설정된 키 이름:"
grep -o -E '^[A-Z_]+' "$ENV_FILE" | tr '\n' ' '; echo
echo "다음: Claude에게 'reins 키 넣었어'라고 알려 주세요."
