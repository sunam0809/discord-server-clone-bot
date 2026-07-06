import {
  Client,
  GatewayIntentBits,
  Partials,
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

const commands = new Collection<string, Command>();
commands.set(cloneCommand.name, {
  data: cloneCommand,
  execute: handleClone,
});

client.once("ready", (c) => {
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
    const msg = { content: "❌ 오류가 발생했습니다.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
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
