import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  Routes,
} from "discord.js";
import { logger } from "../../lib/logger";

export const joinCommand = new SlashCommandBuilder()
  .setName("봇초대")
  .setDescription("서버 초대링크로 봇을 그 서버에 입장시킵니다")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("초대링크")
      .setDescription("discord.gg/XXXXX 형식의 초대링크 또는 코드")
      .setRequired(true),
  );

function extractCode(input: string): string {
  // discord.gg/CODE, discord.com/invite/CODE, https://... 등 다 처리
  const match = input.match(/(?:discord\.gg|discord\.com\/invite)\/([A-Za-z0-9-]+)/);
  if (match) return match[1]!;
  // 코드만 입력한 경우
  return input.trim();
}

export async function handleJoin(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.options.getString("초대링크", true);
  const code = extractCode(raw);

  if (!code) {
    await interaction.editReply("❌ 유효한 초대링크를 입력해주세요. (예: discord.gg/XXXXX)");
    return;
  }

  const rest = interaction.client.rest;

  // 초대 정보 먼저 조회
  let inviteData: { guild?: { id: string; name: string }; code: string };
  try {
    inviteData = (await rest.get(Routes.invite(code), {
      query: new URLSearchParams({ with_counts: "false" }),
    })) as typeof inviteData;
  } catch (err) {
    logger.error({ err, code }, "초대 코드 조회 실패");
    await interaction.editReply("❌ 초대링크가 유효하지 않거나 만료됐어요.");
    return;
  }

  const guildName = inviteData.guild?.name ?? "알 수 없는 서버";
  const guildId = inviteData.guild?.id;

  // 이미 들어가 있는지 확인
  if (guildId && interaction.client.guilds.cache.has(guildId)) {
    await interaction.editReply(
      `ℹ️ 봇이 이미 **${guildName}** 서버에 있어요.\n서버 ID: \`${guildId}\`\n\n이제 \`/복제하기\`에 이 ID를 입력하면 돼요.`,
    );
    return;
  }

  // 봇이 초대 수락 (서버 입장)
  try {
    await rest.post(Routes.invite(code));
  } catch (err) {
    logger.error({ err, code }, "봇 초대 수락 실패");
    await interaction.editReply(
      "❌ 서버 입장에 실패했어요.\n초대링크가 봇에게 유효하지 않을 수 있어요. (만료, 최대인원 초과 등)",
    );
    return;
  }

  logger.info({ guildName, guildId }, "봇 서버 입장 완료");

  await interaction.editReply(
    `✅ **${guildName}** 서버에 봇이 입장했어요!\n` +
      (guildId ? `서버 ID: \`${guildId}\`\n\n이제 \`/복제하기\`에 이 ID를 입력하면 돼요.` : ""),
  );
}
