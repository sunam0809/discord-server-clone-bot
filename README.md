# Discord 서버 복제 봇

디스코드 서버를 통째로 복제하는 봇입니다. 역할, 채널, 카테고리, 권한 설정까지 그대로 복사합니다.

## 기능

- `/복제하기 서버id` — 입력한 서버 ID와 동일한 서버를 새로 생성
  - ✅ 역할 (이름, 색상, 권한, 표시 여부)
  - ✅ 채널 (텍스트, 음성, 카테고리, 공지)
  - ✅ 채널 권한 오버라이트
  - ✅ 채널 옵션 (주제, NSFW, 슬로우모드, 비트레이트 등)
  - ✅ 완료 후 초대 링크 자동 생성

## 제한 사항

- 봇이 **원본 서버에 들어가 있어야** 복제 가능
- Discord API 제한으로 봇이 **10개 미만 서버**에 있어야 새 서버 생성 가능
- 메시지 내역은 복제되지 않음 (Discord API 정책)

## 설정

### 1. 환경변수

```env
DISCORD_BOT_TOKEN=봇_토큰
DISCORD_CLIENT_ID=애플리케이션_ID
```

### 2. 봇 권한

[Discord Developer Portal](https://discord.com/developers) → 봇 설정에서 아래 권한 활성화:
- **Bot Intents**: Server Members Intent, Message Content Intent
- **OAuth2 Scopes**: `bot`, `applications.commands`
- **Bot Permissions**: Administrator (또는 서버 관리, 역할 관리, 채널 관리)

### 3. 슬래시 커맨드 등록

```bash
pnpm --filter @workspace/api-server run deploy-commands
```

### 4. 봇 실행

```bash
pnpm --filter @workspace/api-server run dev
```

## 사용법

1. 봇을 복제하려는 서버에 초대
2. 아무 서버에서 `/복제하기` 실행
3. `서버id` 항목에 복제할 서버의 ID 입력
4. 완료 후 새 서버 초대 링크 확인

## 스택

- Node.js 24 + TypeScript
- discord.js v14
- Express 5 (헬스체크 엔드포인트 포함)
- pnpm 워크스페이스
