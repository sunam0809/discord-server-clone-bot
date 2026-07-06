import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Guild,
  ChannelType,
  OverwriteType,
  GuildChannelCreateOptions,
  MessageFlags,
} from "discord.js";
import { logger } from "../../lib/logger";

export const templateCloneCommand = new SlashCommandBuilder()
  .setName("템플릿복제")
  .setDescription("Discord 서버 템플릿 링크로 이 서버를 복제합니다 (원본 서버에 봇 불필요)")
  .setDMPermission(false)
  .addStringOption((opt) =>
    opt
      .setName("템플릿")
      .setDescription("discord.new/XXXXX 또는 템플릿 코드")
      .setRequired(true),
  );

// ──────────────────────────────────────────
// Discord Template API 타입 정의
// ──────────────────────────────────────────
interface TemplateRole {
  id: number; // 0 = @everyone, 1~N = 나머지
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
}

interface TemplateOverwrite {
  id: number; // 역할의 template id
  type: 0 | 1; // 0=Role, 1=Member
  allow: string;
  deny: string;
}

interface TemplateChannel {
  id: number;
  type: number;
  name: string;
  position: number;
  parent_id: number | null;
  topic?: string | null;
  bitrate?: number;
  user_limit?: number;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  permission_overwrites: TemplateOverwrite[];
}

interface TemplateData {
  code: string;
  name: string;
  serialized_source_guild: {
    name: string;
    icon_hash: string | null;
    roles: TemplateRole[];
    channels: TemplateChannel[];
  };
}

function extractCode(input: string): string {
  const match = input.match(/(?:discord\.new|discord\.com\/template)\/([A-Za-z0-9]+)/);
  return match ? match[1]! : input.trim();
}

export async function handleTemplateClone(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const raw = interaction.options.getString("템플릿", true);
  const code = extractCode(raw);

  // 1) 템플릿 공개 API 조회 (인증 불필요)
  let tpl: TemplateData;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/templates/${code}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      logger.error({ code, status: res.status, err }, "템플릿 조회 실패");
      await interaction.editReply(
        "❌ 템플릿을 찾을 수 없어요. 코드가 맞는지, 공개 템플릿인지 확인해주세요.",
      );
      return;
    }
    tpl = (await res.json()) as TemplateData;
  } catch (err) {
    logger.error({ err, code }, "템플릿 fetch 오류");
    await interaction.editReply("❌ 템플릿을 가져오는 중 오류가 발생했어요.");
    return;
  }

  const srcName = tpl.serialized_source_guild.name;
  const srcRoles = tpl.serialized_source_guild.roles;
  const srcChannels = tpl.serialized_source_guild.channels;

  // 2) 대상 서버
  const destGuild: Guild | null = interaction.guild;
  if (!destGuild) {
    await interaction.editReply("❌ 서버 정보를 가져올 수 없어요.");
    return;
  }

  const currentChannelId = interaction.channelId;

  await interaction.editReply(
    `⏳ **${srcName}** 템플릿 복제 시작...\n채널 초기화 중...`,
  );

  // 3) 기존 채널 삭제 (커맨드 채널 제외)
  try {
    const existing = await destGuild.channels.fetch();
    for (const [id, ch] of existing) {
      if (!ch || id === currentChannelId) continue;
      await ch.delete("템플릿 복제 — 채널 초기화").catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, "채널 삭제 중 일부 실패");
  }

  // 4) 기존 역할 삭제
  try {
    await destGuild.roles.fetch();
    const toDelete = [...destGuild.roles.cache.values()].filter(
      (r) => r.id !== destGuild.roles.everyone.id && !r.managed && r.editable,
    );
    for (const r of toDelete) {
      await r.delete("템플릿 복제 — 역할 초기화").catch(() => null);
    }
  } catch (err) {
    logger.warn({ err }, "역할 삭제 중 일부 실패");
  }

  await interaction.editReply("⏳ 역할 복제 중...");

  // 5) 역할 복제
  // templateId(number) → 실제 Discord role id(string) 매핑
  const roleMap = new Map<number, string>();
  // 0 = @everyone
  roleMap.set(0, destGuild.roles.everyone.id);

  // @everyone 권한 업데이트
  const everyoneTpl = srcRoles.find((r) => r.id === 0);
  if (everyoneTpl) {
    await destGuild.roles.everyone
      .setPermissions(BigInt(everyoneTpl.permissions), "템플릿 복제")
      .catch(() => null);
  }

  const otherRoles = srcRoles
    .filter((r) => r.id !== 0)
    .sort((a, b) => a.id - b.id);

  let roleCount = 0;
  for (const role of otherRoles) {
    try {
      const newRole = await destGuild.roles.create({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: BigInt(role.permissions),
        reason: "템플릿 복제",
      });
      roleMap.set(role.id, newRole.id);
      roleCount++;
    } catch (err) {
      logger.warn({ err, role: role.name }, "역할 생성 실패 — 건너뜀");
    }
  }

  await interaction.editReply(`✅ 역할 ${roleCount}개 완료.\n📁 채널 복제 중...`);

  // 6) 채널 복제 — 카테고리 먼저
  // templateId(number) → 실제 channel id(string) 매핑
  const channelMap = new Map<number, string>();

  const categories = srcChannels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  const rest = srcChannels
    .filter((c) => c.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  for (const cat of categories) {
    try {
      const newCat = await destGuild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        position: cat.position,
        permissionOverwrites: buildOverwrites(cat.permission_overwrites, roleMap),
        reason: "템플릿 복제",
      });
      channelMap.set(cat.id, newCat.id);
    } catch (err) {
      logger.warn({ err, ch: cat.name }, "카테고리 생성 실패");
    }
  }

  let channelCount = 0;
  for (const ch of rest) {
    try {
      const parentId = ch.parent_id != null ? channelMap.get(ch.parent_id) : undefined;
      const overwrites = buildOverwrites(ch.permission_overwrites, roleMap);

      let options: GuildChannelCreateOptions;

      if (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) {
        options = {
          name: ch.name,
          type: ch.type as ChannelType.GuildVoice | ChannelType.GuildStageVoice,
          position: ch.position,
          permissionOverwrites: overwrites,
          parent: parentId ?? null,
          bitrate: ch.bitrate ?? 64000,
          userLimit: ch.user_limit ?? 0,
          reason: "템플릿 복제",
        };
      } else {
        options = {
          name: ch.name,
          type: ch.type as ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildForum,
          position: ch.position,
          permissionOverwrites: overwrites,
          parent: parentId ?? null,
          topic: ch.topic ?? undefined,
          nsfw: ch.nsfw ?? false,
          rateLimitPerUser: ch.rate_limit_per_user ?? 0,
          reason: "템플릿 복제",
        };
      }

      await destGuild.channels.create(options);
      channelCount++;
    } catch (err) {
      logger.warn({ err, ch: ch.name }, "채널 생성 실패 — 건너뜀");
    }
  }

  // 7) 남겨뒀던 커맨드 채널 삭제
  try {
    const cur = destGuild.channels.cache.get(currentChannelId);
    if (cur) await cur.delete("템플릿 복제 — 마지막 채널 정리").catch(() => null);
  } catch { /* 무시 */ }

  // 8) 서버 이름 업데이트
  try {
    await destGuild.setName(`${srcName} (복제본)`, "템플릿 복제");
  } catch (err) {
    logger.warn({ err }, "서버 이름 변경 실패");
  }

  logger.info({ srcName, dest: destGuild.name, roleCount, channelCount }, "템플릿 복제 완료");
}

function buildOverwrites(
  overwrites: TemplateOverwrite[],
  roleMap: Map<number, string>,
) {
  return overwrites.flatMap((ow) => {
    if (ow.type === 0) {
      // Role overwrite — template role id로 매핑
      const newId = roleMap.get(ow.id);
      if (!newId) return [];
      return [{ id: newId, type: OverwriteType.Role, allow: BigInt(ow.allow), deny: BigInt(ow.deny) }];
    } else {
      // Member overwrite — 실제 user id 그대로
      return [{ id: String(ow.id), type: OverwriteType.Member, allow: BigInt(ow.allow), deny: BigInt(ow.deny) }];
    }
  });
}
