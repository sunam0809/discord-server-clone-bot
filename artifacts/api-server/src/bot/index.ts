import {
  Client,
  GatewayIntentBits,
  Collection,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { cloneCommand, handleClone } from "./commands/clone";

export interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// 처리되지 않은 에러로 서버 크래시 방지
client.on("error", (err) => {
  logger.error({ err }, "Discord 클라이언트 오류");
});

const commands = new Collection<string, Command>();
commands.set(cloneCommand.name, {
  data: cloneCommand,
  execute: handleClone,
});

client.once("clientReady", (c) => {
  logger.info(`봇 로그인 완료: ${c.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error({ err }, "커맨드 실행 오류");
    try {
      const msg = { content: "❌ 오류가 발생했습니다.", flags: 64 } as const;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch {
      // interaction 만료 등으로 응답 불가 — 무시
    }
  }
});

export function startBot() {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN 없음 — 봇 실행 건너뜀");
    return;
  }
  client.login(token).catch((err) => {
    logger.error({ err }, "봇 로그인 실패");
  });
}
