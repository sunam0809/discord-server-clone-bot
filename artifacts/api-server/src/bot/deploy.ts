/**
 * 슬래시 커맨드 등록 스크립트
 * 실행: node -e "import('./dist/bot/deploy.mjs').then(m => m.deployCommands())"
 * 또는 환경변수 세팅 후: pnpm --filter @workspace/api-server run deploy-commands
 */
import { REST, Routes } from "discord.js";
import { logger } from "../lib/logger";
import { cloneCommand } from "./commands/clone";
import { templateCloneCommand } from "./commands/template-clone";

export async function deployCommands() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  const clientId = process.env["DISCORD_CLIENT_ID"];

  if (!token || !clientId) {
    throw new Error("DISCORD_BOT_TOKEN 또는 DISCORD_CLIENT_ID 환경변수가 없습니다.");
  }

  const rest = new REST().setToken(token);
  const commands = [cloneCommand.toJSON(), templateCloneCommand.toJSON()];

  logger.info("슬래시 커맨드 등록 중...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  logger.info("✅ 슬래시 커맨드 등록 완료!");
}

// 직접 실행 시
deployCommands().catch((err) => {
  logger.error({ err }, "커맨드 등록 실패");
  process.exit(1);
});
