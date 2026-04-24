const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");

// コマンドを受け付けるテキストチャンネル名（空文字にすると制限なし）
const ADMIN_CHANNEL_NAME = "moveeradmin";

function checkAdminChannel(interaction) {
  if (!ADMIN_CHANNEL_NAME) return true;
  return interaction.channel.name === ADMIN_CHANNEL_NAME;
}

function adminChannelError(interaction) {
  return interaction.reply({
    content: `❌ このコマンドは \`${ADMIN_CHANNEL_NAME}\` チャンネルでのみ使用できます。`,
    ephemeral: true,
  });
}

function resultEmbed(title, fields) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .addFields(fields)
    .setTimestamp();
}

// ─── /move ────────────────────────────────────────────────────────────────────
// 指定ユーザーをあなたのいるVCに移動
const moveCommand = {
  data: new SlashCommandBuilder()
    .setName("move")
    .setDescription("指定したユーザーをあなたのいるVCに移動します")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addUserOption((o) => o.setName("user1").setDescription("移動するユーザー").setRequired(true))
    .addUserOption((o) => o.setName("user2").setDescription("移動するユーザー2"))
    .addUserOption((o) => o.setName("user3").setDescription("移動するユーザー3"))
    .addUserOption((o) => o.setName("user4").setDescription("移動するユーザー4"))
    .addUserOption((o) => o.setName("user5").setDescription("移動するユーザー5")),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const myVC = interaction.member.voice.channel;
    if (!myVC)
      return interaction.reply({ content: "❌ あなたがボイスチャンネルに参加していません。", ephemeral: true });

    const members = ["user1", "user2", "user3", "user4", "user5"]
      .map((k) => interaction.options.getMember(k))
      .filter(Boolean);

    let moved = 0, failed = 0;
    for (const m of members) {
      try { await m.voice.setChannel(myVC); moved++; } catch { failed++; }
    }

    await interaction.reply({
      embeds: [resultEmbed("🔀 ユーザーを移動しました", [
        { name: "移動先", value: myVC.name, inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
      ephemeral: true,
    });
  },
};

// ─── /cmove ───────────────────────────────────────────────────────────────────
// 指定ユーザーを指定VCに移動
const cmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("cmove")
    .setDescription("指定したユーザーを指定のVCに移動します")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o.setName("channel").setDescription("移動先のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .addUserOption((o) => o.setName("user1").setDescription("移動するユーザー").setRequired(true))
    .addUserOption((o) => o.setName("user2").setDescription("移動するユーザー2"))
    .addUserOption((o) => o.setName("user3").setDescription("移動するユーザー3"))
    .addUserOption((o) => o.setName("user4").setDescription("移動するユーザー4"))
    .addUserOption((o) => o.setName("user5").setDescription("移動するユーザー5")),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const targetVC = interaction.options.getChannel("channel");
    const members = ["user1", "user2", "user3", "user4", "user5"]
      .map((k) => interaction.options.getMember(k))
      .filter(Boolean);

    let moved = 0, failed = 0;
    for (const m of members) {
      try { await m.voice.setChannel(targetVC); moved++; } catch { failed++; }
    }

    await interaction.reply({
      embeds: [resultEmbed("🔀 ユーザーを移動しました", [
        { name: "移動先", value: targetVC.name, inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
      ephemeral: true,
    });
  },
};

// ─── /fmove ───────────────────────────────────────────────────────────────────
// あるVCの全員を別VCへ移動（Among Us のミュート管理に最適）
const fmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("fmove")
    .setDescription("あるVCにいる全員を別のVCに移動します（Among Us のミュート管理などに便利）")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o.setName("from").setDescription("移動元のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .addChannelOption((o) =>
      o.setName("to").setDescription("移動先のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    ),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const fromVC = interaction.options.getChannel("from");
    const toVC   = interaction.options.getChannel("to");

    await interaction.deferReply({ ephemeral: true });

    const members = [...fromVC.members.values()];
    let moved = 0, failed = 0;
    for (const m of members) {
      try { await m.voice.setChannel(toVC); moved++; } catch { failed++; }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 チャンネル間移動完了", [
        { name: "移動元", value: fromVC.name, inline: true },
        { name: "移動先", value: toVC.name, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /gmove ───────────────────────────────────────────────────────────────────
// 指定VCの全員をあなたのVCに移動
const gmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("gmove")
    .setDescription("指定VCにいる全員をあなたのいるVCに移動します")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o.setName("channel").setDescription("移動元のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    ),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const myVC   = interaction.member.voice.channel;
    if (!myVC)
      return interaction.reply({ content: "❌ あなたがボイスチャンネルに参加していません。", ephemeral: true });

    const fromVC = interaction.options.getChannel("channel");

    await interaction.deferReply({ ephemeral: true });

    const members = [...fromVC.members.values()];
    let moved = 0, failed = 0;
    for (const m of members) {
      try { await m.voice.setChannel(myVC); moved++; } catch { failed++; }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 全員を集合させました", [
        { name: "移動元", value: fromVC.name, inline: true },
        { name: "移動先", value: myVC.name, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /rmove ───────────────────────────────────────────────────────────────────
// 指定ロールのユーザーをあなたのVCに移動
const rmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("rmove")
    .setDescription("指定ロールを持つユーザーをあなたのVCに移動します")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addRoleOption((o) => o.setName("role").setDescription("対象ロール").setRequired(true)),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const myVC = interaction.member.voice.channel;
    if (!myVC)
      return interaction.reply({ content: "❌ あなたがボイスチャンネルに参加していません。", ephemeral: true });

    const role = interaction.options.getRole("role");

    await interaction.deferReply({ ephemeral: true });

    const targets = interaction.guild.members.cache.filter(
      (m) => m.roles.cache.has(role.id) && m.voice.channel && m.voice.channelId !== myVC.id
    );

    let moved = 0, failed = 0;
    for (const m of targets.values()) {
      try { await m.voice.setChannel(myVC); moved++; } catch { failed++; }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 ロールメンバーを移動しました", [
        { name: "ロール", value: role.name, inline: true },
        { name: "移動先", value: myVC.name, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /tmove ───────────────────────────────────────────────────────────────────
// 指定ロールのユーザーを指定VCに移動
const tmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("tmove")
    .setDescription("指定ロールを持つユーザーを指定のVCに移動します")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addRoleOption((o) => o.setName("role").setDescription("対象ロール").setRequired(true))
    .addChannelOption((o) =>
      o.setName("channel").setDescription("移動先のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    ),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const role     = interaction.options.getRole("role");
    const targetVC = interaction.options.getChannel("channel");

    await interaction.deferReply({ ephemeral: true });

    const targets = interaction.guild.members.cache.filter(
      (m) => m.roles.cache.has(role.id) && m.voice.channel && m.voice.channelId !== targetVC.id
    );

    let moved = 0, failed = 0;
    for (const m of targets.values()) {
      try { await m.voice.setChannel(targetVC); moved++; } catch { failed++; }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 ロールメンバーを移動しました", [
        { name: "ロール", value: role.name, inline: true },
        { name: "移動先", value: targetVC.name, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /ymove ───────────────────────────────────────────────────────────────────
// VCのユーザーをカテゴリ内の複数VCに均等分散
const ymoveCommand = {
  data: new SlashCommandBuilder()
    .setName("ymove")
    .setDescription("VCのユーザーをカテゴリ内の複数VCに均等に分散させます")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o.setName("from").setDescription("分散元のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .addIntegerOption((o) =>
      o.setName("count").setDescription("分散先チャンネル数（2〜10）").setRequired(true)
        .setMinValue(2).setMaxValue(10)
    ),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const fromVC = interaction.options.getChannel("from");
    const count  = interaction.options.getInteger("count");

    if (!fromVC.parentId)
      return interaction.reply({ content: "❌ 指定したVCはカテゴリに属していません。", ephemeral: true });

    // カテゴリ内の他のVCを取得（fromVC除く）
    const siblingVCs = [
      ...interaction.guild.channels.cache
        .filter(
          (c) =>
            c.parentId === fromVC.parentId &&
            (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) &&
            c.id !== fromVC.id
        )
        .values(),
    ].slice(0, count - 1);

    if (siblingVCs.length < 1)
      return interaction.reply({ content: "❌ カテゴリ内に分散先のVCが足りません。", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const destVCs = [fromVC, ...siblingVCs]; // 均等分散先（fromVC も含む）
    const members = [...fromVC.members.values()];
    let moved = 0, failed = 0;

    // インデックス 0 はそのまま fromVC に残す → i=1 から移動
    for (let i = 1; i < members.length; i++) {
      const dest = destVCs[i % destVCs.length];
      if (dest.id === fromVC.id) continue; // fromVC なら移動不要
      try { await members[i].voice.setChannel(dest); moved++; } catch { failed++; }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 ユーザーを分散しました", [
        { name: "分散元", value: fromVC.name, inline: true },
        { name: "分散先", value: destVCs.map((v) => v.name).join(", ") },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /zmove ───────────────────────────────────────────────────────────────────
// カテゴリ内の全VCユーザーを1つのVCに集める
const zmoveCommand = {
  data: new SlashCommandBuilder()
    .setName("zmove")
    .setDescription("カテゴリ内の全VCにいるユーザーを1つのVCに集めます")
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addChannelOption((o) =>
      o.setName("to").setDescription("集合先のVC").setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    ),

  async execute(interaction) {
    if (!checkAdminChannel(interaction)) return adminChannelError(interaction);

    const toVC = interaction.options.getChannel("to");

    if (!toVC.parentId)
      return interaction.reply({ content: "❌ 指定したVCはカテゴリに属していません。", ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const siblingVCs = interaction.guild.channels.cache.filter(
      (c) =>
        c.parentId === toVC.parentId &&
        (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) &&
        c.id !== toVC.id
    );

    let moved = 0, failed = 0;
    for (const vc of siblingVCs.values()) {
      for (const m of vc.members.values()) {
        try { await m.voice.setChannel(toVC); moved++; } catch { failed++; }
      }
    }

    await interaction.editReply({
      embeds: [resultEmbed("🔀 カテゴリ内全員を集合させました", [
        { name: "集合先", value: toVC.name, inline: true },
        { name: "成功", value: `${moved} 人`, inline: true },
        { name: "失敗", value: `${failed} 人`, inline: true },
      ])],
    });
  },
};

// ─── /setup ───────────────────────────────────────────────────────────────────
const setupCommand = {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("初期設定パネルを表示します")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    // index.js側で interaction をフックして処理するため、ここでは deferReply のみ
    // または直接パネルを送信する関数を呼び出す（今回は index.js で共通化）
    await interaction.deferReply({ ephemeral: true });
    // index.js の interactionCreate で実際の処理を行うため、ここではフラグのみ
    interaction.client.emit("setup_command", interaction);
  },
};

module.exports = [
  moveCommand,
  cmoveCommand,
  fmoveCommand,
  gmoveCommand,
  rmoveCommand,
  tmoveCommand,
  ymoveCommand,
  zmoveCommand,
  setupCommand,
];
