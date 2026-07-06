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
  .setDescription("다른 서버를 복제해서 새 서버를 만듭니다")
  .addStringOption((opt) =>
    opt
      .setName("서버id")
      .setDescription("복제할 서버의 ID")
      .setRequired(true),
  );

export async function handleClone(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const sourceId = interaction.options.getString("서버id", true).trim();
  const client = interaction.client;

  // 1) 원본 서버 가져오기
  let sourceGuild: Guild;
  try {
    sourceGuild = await client.guilds.fetch(sourceId);
    await sourceGuild.fetch();
    await sourceGuild.roles.fetch();
    await sourceGuild.channels.fetch();
  } catch {
    await interaction.editReply(
      "❌ 서버를 찾을 수 없어요. 봇이 해당 서버에 들어가 있는지 확인하고 ID도 다시 확인해주세요.",
    );
    return;
  }

  await interaction.editReply("⏳ 서버 복제 시작... (역할 → 채널 → 권한 순으로 진행)");

  // 2) 새 서버 생성
  let newGuild: Guild;
  try {
    newGuild = await client.guilds.create({
      name: `${sourceGuild.name} (복제본)`,
      icon: sourceGuild.iconURL() ?? undefined,
    });
  } catch (err) {
    logger.error({ err }, "서버 생성 실패");
    await interaction.editReply(
      "❌ 새 서버 생성에 실패했어요. 봇이 10개 미만 서버에 있어야 서버를 만들 수 있어요.",
    );
    return;
  }

  try {
    // 3) 기본 채널 삭제
    const defaultChannels = await newGuild.channels.fetch();
    for (const [, ch] of defaultChannels) {
      if (ch) await ch.delete().catch(() => null);
    }

    // 4) 역할 복제 (@everyone 제외, 포지션 순 정렬)
    const roleMap = new Map<string, string>();
    roleMap.set(sourceGuild.roles.everyone.id, newGuild.roles.everyone.id);

    const roles = [...sourceGuild.roles.cache.values()]
      .filter((r) => r.id !== sourceGuild.roles.everyone.id && !r.managed)
      .sort((a, b) => a.rawPosition - b.rawPosition);

    for (const role of roles) {
      try {
        const newRole = await newGuild.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: role.permissions,
          position: role.rawPosition,
        });
        roleMap.set(role.id, newRole.id);
      } catch (err) {
        logger.warn({ err, role: role.name }, "역할 생성 실패 — 건너뜀");
      }
    }

    await interaction.editReply(`✅ 역할 ${roleMap.size - 1}개 복제 완료. 채널 복제 중...`);

    // 5) 채널 복제 — 카테고리 먼저
    const channelMap = new Map<string, string>();
    const allChannels = [...sourceGuild.channels.cache.values()] as GuildChannel[];

    const categories = allChannels
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => a.rawPosition - b.rawPosition) as CategoryChannel[];

    const rest = allChannels
      .filter((c) => c.type !== ChannelType.GuildCategory)
      .sort((a, b) => a.rawPosition - b.rawPosition);

    // 카테고리 생성
    for (const cat of categories) {
      try {
        const newCat = await newGuild.channels.create({
          name: cat.name,
          type: ChannelType.GuildCategory,
          position: cat.rawPosition,
          permissionOverwrites: buildOverwrites(cat.permissionOverwrites, roleMap),
        });
        channelMap.set(cat.id, newCat.id);
      } catch (err) {
        logger.warn({ err, ch: cat.name }, "카테고리 생성 실패");
      }
    }

    // 나머지 채널 생성
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
            nsfw: "nsfw" in ch ? (ch as TextChannel).nsfw : false,
            rateLimitPerUser: "rateLimitPerUser" in ch ? (ch as TextChannel).rateLimitPerUser : 0,
          };
        }

        const newCh = await newGuild.channels.create(options);
        channelMap.set(ch.id, newCh.id);
      } catch (err) {
        logger.warn({ err, ch: ch.name }, "채널 생성 실패 — 건너뜀");
      }
    }

    // 6) 초대 링크 생성
    const inviteChannel = newGuild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(newGuild.roles.everyone)?.has("ViewChannel"),
    ) as TextChannel | undefined;

    let invite = "";
    if (inviteChannel) {
      const inv = await inviteChannel.createInvite({ maxAge: 0 });
      invite = `\n🔗 초대 링크: ${inv.url}`;
    }

    await interaction.editReply(
      `🎉 복제 완료!\n` +
        `• 원본 서버: **${sourceGuild.name}**\n` +
        `• 역할: ${roleMap.size - 1}개\n` +
        `• 채널: ${channelMap.size}개${invite}`,
    );
  } catch (err) {
    logger.error({ err }, "복제 중 오류");
    await newGuild.delete().catch(() => null);
    await interaction.editReply("❌ 복제 중 오류가 발생해서 새 서버를 삭제했어요. 다시 시도해주세요.");
  }
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
