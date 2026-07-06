import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Guild,
  ChannelType,
  PermissionOverwriteManager,
  OverwriteType,
  GuildChannelCreateOptions,
  TextChannel,
  VoiceChannel,
  CategoryChannel,
  GuildChannel,
} from "discord.js";
import { logger } from "../../lib/logger";

export const cloneCommand = new SlashCommandBuilder()
  .setName("복제하기")
  .setDescription("다른 서버를 이 서버에 복제합니다 (역할·채널·권한 전부)")
  .addStringOption((opt) =>
    opt
      .setName("서버id")
      .setDescription("복제할 원본 서버의 ID")
      .setRequired(true),
  );

export async function handleClone(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const sourceId = interaction.options.getString("서버id", true).trim();
  const client = interaction.client;

  // 대상 서버 = 커맨드를 실행한 현재 서버
  const destGuild = interaction.guild;
  if (!destGuild) {
    await interaction.editReply("❌ 서버 내에서만 사용할 수 있어요.");
    return;
  }

  // 1) 원본 서버 가져오기
  let sourceGuild: Guild;
  try {
    sourceGuild = await client.guilds.fetch(sourceId);
    await sourceGuild.fetch();
    await sourceGuild.roles.fetch();
    await sourceGuild.channels.fetch();
  } catch {
    await interaction.editReply(
      "❌ 원본 서버를 찾을 수 없어요.\n봇이 원본 서버에도 들어가 있는지 확인해주세요.",
    );
    return;
  }

  if (sourceGuild.id === destGuild.id) {
    await interaction.editReply("❌ 원본 서버와 대상 서버가 같아요.");
    return;
  }

  await interaction.editReply(
    `⏳ **${sourceGuild.name}** → **${destGuild.name}** 복제 시작...\n역할 복제 중...`,
  );

  // 2) 기존 채널 전부 삭제
  try {
    const existing = await destGuild.channels.fetch();
    for (const [, ch] of existing) {
      if (ch) await ch.delete("서버 복제 — 기존 채널 초기화").catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, "기존 채널 삭제 중 일부 실패");
  }

  // 3) 역할 복제 (@everyone 제외, 봇 관리 역할 제외)
  const roleMap = new Map<string, string>();
  roleMap.set(sourceGuild.roles.everyone.id, destGuild.roles.everyone.id);

  const roles = [...sourceGuild.roles.cache.values()]
    .filter((r) => r.id !== sourceGuild.roles.everyone.id && !r.managed)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  let roleCount = 0;
  for (const role of roles) {
    try {
      const newRole = await destGuild.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions,
        position: role.rawPosition,
        reason: "서버 복제",
      });
      roleMap.set(role.id, newRole.id);
      roleCount++;
    } catch (err) {
      logger.warn({ err, role: role.name }, "역할 생성 실패 — 건너뜀");
    }
  }

  await interaction.editReply(
    `✅ 역할 ${roleCount}개 완료.\n📁 채널 복제 중...`,
  );

  // 4) 채널 복제 — 카테고리 먼저, 그 다음 나머지
  const channelMap = new Map<string, string>();
  const allChannels = [...sourceGuild.channels.cache.values()] as GuildChannel[];

  const categories = allChannels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition) as CategoryChannel[];

  const rest = allChannels
    .filter((c) => c.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  // 카테고리
  for (const cat of categories) {
    try {
      const newCat = await destGuild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        position: cat.rawPosition,
        permissionOverwrites: buildOverwrites(cat.permissionOverwrites, roleMap),
        reason: "서버 복제",
      });
      channelMap.set(cat.id, newCat.id);
    } catch (err) {
      logger.warn({ err, ch: cat.name }, "카테고리 생성 실패");
    }
  }

  // 나머지 채널
  for (const ch of rest) {
    try {
      const parentId = ch.parentId ? channelMap.get(ch.parentId) : undefined;
      const overwrites = buildOverwrites(ch.permissionOverwrites, roleMap);

      let options: GuildChannelCreateOptions;

      if (
        ch.type === ChannelType.GuildVoice ||
        ch.type === ChannelType.GuildStageVoice
      ) {
        const vc = ch as VoiceChannel;
        options = {
          name: ch.name,
          type: ch.type,
          position: ch.rawPosition,
          permissionOverwrites: overwrites,
          parent: parentId ?? null,
          bitrate: vc.bitrate,
          userLimit: vc.userLimit,
          reason: "서버 복제",
        };
      } else {
        const tc = ch as TextChannel;
        options = {
          name: ch.name,
          type: ch.type as
            | ChannelType.GuildText
            | ChannelType.GuildAnnouncement
            | ChannelType.GuildForum,
          position: ch.rawPosition,
          permissionOverwrites: overwrites,
          parent: parentId ?? null,
          topic: tc.topic ?? undefined,
          nsfw: "nsfw" in ch ? tc.nsfw : false,
          rateLimitPerUser:
            "rateLimitPerUser" in ch ? tc.rateLimitPerUser : 0,
          reason: "서버 복제",
        };
      }

      const newCh = await destGuild.channels.create(options);
      channelMap.set(ch.id, newCh.id);
    } catch (err) {
      logger.warn({ err, ch: ch.name }, "채널 생성 실패 — 건너뜀");
    }
  }

  // 5) 서버 이름·아이콘 업데이트
  try {
    await destGuild.setName(`${sourceGuild.name} (복제본)`, "서버 복제");
    const iconUrl = sourceGuild.iconURL({ extension: "png", size: 512 });
    if (iconUrl) {
      await destGuild.setIcon(iconUrl, "서버 복제");
    }
  } catch (err) {
    logger.warn({ err }, "서버 이름/아이콘 변경 실패");
  }

  await interaction.editReply(
    `🎉 **복제 완료!**\n` +
      `• 원본: **${sourceGuild.name}**\n` +
      `• 역할: **${roleCount}개**\n` +
      `• 채널: **${channelMap.size}개**\n\n` +
      `이 서버가 이제 복제본이에요.`,
  );
}

function buildOverwrites(
  manager: PermissionOverwriteManager,
  roleMap: Map<string, string>,
) {
  return [...manager.cache.values()].flatMap((ow) => {
    const newId =
      ow.type === OverwriteType.Role ? roleMap.get(ow.id) : ow.id;
    if (!newId) return [];
    return [{ id: newId, type: ow.type, allow: ow.allow, deny: ow.deny }];
  });
}
