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
  MessageFlags,
} from "discord.js";
import { logger } from "../../lib/logger";

export const cloneCommand = new SlashCommandBuilder()
  .setName("복제하기")
  .setDescription("다른 서버를 이 서버에 복제합니다 (역할·채널·권한 전부)")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("서버id")
      .setDescription("복제할 원본 서버의 ID")
      .setRequired(true),
  );

export async function handleClone(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sourceId = interaction.options.getString("서버id", true).trim();
  const client = interaction.client;

  // 대상 서버
  let destGuild: Guild | null = interaction.guild;
  if (!destGuild && interaction.guildId) {
    destGuild = await client.guilds
      .fetch({ guild: interaction.guildId, force: true })
      .catch((err) => {
        logger.error({ err, guildId: interaction.guildId }, "대상 서버 fetch 실패");
        return null;
      });
  }
  if (!destGuild) {
    await interaction.editReply(
      "❌ 봇이 이 서버의 멤버가 아니에요.\n" +
        "초대 링크에 **`bot`** 스코프가 포함돼야 해요.\n" +
        "OAuth2 → URL Generator → `bot` + `applications.commands` 둘 다 체크 후 다시 초대해주세요.",
    );
    return;
  }

  // 원본 서버
  let sourceGuild: Guild;
  try {
    sourceGuild = await client.guilds.fetch({ guild: sourceId, force: true });
    await sourceGuild.roles.fetch();
    await sourceGuild.channels.fetch();
  } catch (err) {
    logger.error({ err, sourceId }, "원본 서버 fetch 실패");
    await interaction.editReply(
      "❌ 원본 서버를 찾을 수 없어요.\n봇이 원본 서버에도 들어가 있어야 해요.",
    );
    return;
  }

  if (sourceGuild.id === destGuild.id) {
    await interaction.editReply("❌ 원본 서버와 대상 서버가 같아요.");
    return;
  }

  const currentChannelId = interaction.channelId;

  await interaction.editReply(
    `⏳ **${sourceGuild.name}** → **${destGuild.name}** 복제 시작...\n채널 초기화 중...`,
  );

  // 기존 채널 삭제 — 커맨드를 쓴 채널은 마지막에 처리
  try {
    const existing = await destGuild.channels.fetch();
    for (const [id, ch] of existing) {
      if (!ch || id === currentChannelId) continue; // 현재 채널 건너뜀
      await ch.delete("서버 복제 — 채널 초기화").catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, "기존 채널 삭제 중 일부 실패");
  }

  // 기존 역할 전부 삭제 (@everyone, 봇 관리 역할 제외)
  try {
    await destGuild.roles.fetch();
    const existingRoles = [...destGuild.roles.cache.values()].filter(
      (r) => r.id !== destGuild!.roles.everyone.id && !r.managed && r.editable,
    );
    for (const role of existingRoles) {
      await role.delete("서버 복제 — 역할 초기화").catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, "기존 역할 삭제 중 일부 실패");
  }

  await interaction.editReply(`⏳ 역할 복제 중...`);

  // 역할 복제
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

  await interaction.editReply(`✅ 역할 ${roleCount}개 완료.\n📁 채널 복제 중...`);

  // 채널 복제 — 카테고리 먼저
  const channelMap = new Map<string, string>();
  const allChannels = [...sourceGuild.channels.cache.values()] as GuildChannel[];

  const categories = allChannels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition) as CategoryChannel[];

  const rest = allChannels
    .filter((c) => c.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition);

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

  for (const ch of rest) {
    try {
      const parentId = ch.parentId ? channelMap.get(ch.parentId) : undefined;
      const overwrites = buildOverwrites(ch.permissionOverwrites, roleMap);

      let options: GuildChannelCreateOptions;

      if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
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
          rateLimitPerUser: "rateLimitPerUser" in ch ? tc.rateLimitPerUser : 0,
          reason: "서버 복제",
        };
      }

      const newCh = await destGuild.channels.create(options);
      channelMap.set(ch.id, newCh.id);
    } catch (err) {
      logger.warn({ err, ch: ch.name }, "채널 생성 실패 — 건너뜀");
    }
  }

  // 복제 완료 후 남겨뒀던 현재 채널 삭제
  try {
    const currentCh = destGuild.channels.cache.get(currentChannelId);
    if (currentCh) await currentCh.delete("서버 복제 — 마지막 채널 정리").catch(() => null);
  } catch {
    // 무시
  }

  // 서버 이름·아이콘 업데이트
  try {
    await destGuild.setName(`${sourceGuild.name} (복제본)`, "서버 복제");
    const iconUrl = sourceGuild.iconURL({ extension: "png", size: 512 });
    if (iconUrl) await destGuild.setIcon(iconUrl, "서버 복제");
  } catch (err) {
    logger.warn({ err }, "서버 이름/아이콘 변경 실패");
  }

  logger.info(
    { source: sourceGuild.name, dest: destGuild.name, roleCount, channelCount: channelMap.size },
    "복제 완료",
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
